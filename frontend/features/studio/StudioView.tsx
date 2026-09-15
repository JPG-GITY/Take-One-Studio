'use client'

/**
 * Studio (Free Gen) — a standalone, Lumina-style generation playground that is
 * FULLY INDEPENDENT of the pipeline: its own persisted history (studio.store),
 * its own isolated backend routes (/api/studio/*), no project required, and it
 * never reads or writes the pipeline store. So nothing here can affect
 * Script / Breakdown / SG / Final Cut.
 *
 * Center is a scrollable FEED of generations (newest at the bottom): each entry
 * shows its prompt + settings + image(s) and offers Re-edit / Regenerate / Delete.
 * The prompt bar clears on submit; the right Gallery mirrors the feed as thumbnails.
 *
 * F1: image generation (Seedream 5.0, Pro by default). Video (Seedance 2.0) lands in F2.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Sparkles, Film, Music, UserPlus, Maximize2, Trash2, Download, Plus, X, ImageIcon, Loader2, Settings2, ChevronDown, Wand2, Pencil, RefreshCw, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AnimatePanel } from './AnimatePanel'
import { CharacterCreator } from './CharacterCreator'
import { ProImageEditor } from '@/features/stage3-assets/ProImageEditor'
import { pipelineApi } from '@/lib/api/pipeline.api'
import { apiClient } from '@/lib/api/client'
import { UPSCALE_RES, UPSCALE_TIERS, UPSCALE_STYLES, type UpRes, type UpTier, type UpStyle } from '@/lib/upscale'
import { isAudioFilterBlock } from '@/lib/seedanceFilters'
import { PromptBlock } from './PromptBlock'
import { maxImageRefsFor, maxVideoRefsFor, maxAudioRefsFor, refSecsFor, refToken } from '@/lib/segments'
import { useStudioStore, type StudioItem, type StudioKind, type PendingUpscale } from '@/store/studio.store'
import { usePipelineStore } from '@/store/pipeline.store'

type GenType = 'image' | 'video' | 'voice'

// Default label only — the real model is whatever SEEDREAM_MODEL resolves to server-side
// (Pro by default); /api/studio/image reports it back and we show THAT, so this label can
// never silently go stale again (it read "Lite" long after the default moved to Pro).
/** How many times a render blocked by Seedance's output-audio copyright filter is
 *  resubmitted, unchanged and with audio still ON. Measured 2026-09-02: 5 of 6 audio-ON
 *  attempts at one talking close-up were blocked, and the wording of the prompt did not
 *  move it (see the retry loop for the task ids). Three retries take the ~17% observed
 *  per-attempt success rate to roughly 1 in 2 — worth ~6 minutes of wall clock, and a
 *  blocked task carries no `usage` object, so the failed attempts appear unbilled. Set to
 *  0 to go back to one attempt and decide by hand. */
const AUDIO_FILTER_RETRIES = 3

const IMAGE_MODEL = 'Seedream 5.0 Pro'
/** Friendly name for a returned Seedream model id. */
const imageModelLabel = (id?: string): string =>
  !id ? IMAGE_MODEL
    : /pro/i.test(id) ? 'Seedream 5.0 Pro'
    : /lite/i.test(id) ? 'Seedream 5.0 Lite'
    : id
const VOICE_MODEL = 'Seed TTS 2.0'
// Seed Audio 1.0 — separate product/host/key from Seed TTS 2.0 (audio-generation.md).
const AUDIO_MODEL = 'Seed Audio 1.0'
/** Audio engines, richest first — Seed Audio is the default because it is the only one
 *  that can render a scene (score + SFX + dialogue), not just speak a line. */
const AUDIO_ENGINES = [
  { id: 'seedaudio' as const, label: 'Seed Audio 1.0', hint: 'Scenes, cloning, 20 languages' },
  { id: 'tts2' as const, label: 'Seed TTS 2.0', hint: 'Preset voice roster' },
]
// Labels for results that came out of an edit rather than a fresh generation.
const IMAGE_EDIT_MODEL = 'Seedream 5.0 Pro · edit'
const VIDEO_EDIT_MODEL = 'Seedance 2.0 · edit'
const VIDEO_EXTEND_MODEL = 'Seedance 2.0 · extend'
// Full Seed TTS 2.0 voice roster (paste any other id into the custom field).
const VOICES: { id: string; name: string; lang: string; gender: 'F' | 'M' }[] = [
  { id: 'en_female_stokie_uranus_bigtts', name: 'Stokie', lang: 'EN', gender: 'F' },
  { id: 'en_female_dacey_uranus_bigtts', name: 'Dacey', lang: 'EN', gender: 'F' },
  { id: 'en_male_tim_uranus_bigtts', name: 'Tim', lang: 'EN', gender: 'M' },
  { id: 'zh_male_m191_uranus_bigtts', name: 'Kian', lang: 'EN/ZH', gender: 'M' },
  { id: 'zh_male_taocheng_uranus_bigtts', name: 'Cedric', lang: 'EN/ZH', gender: 'M' },
  { id: 'zh_male_dayi_uranus_bigtts', name: 'Magnus', lang: 'EN/ZH', gender: 'M' },
  { id: 'zh_male_ruyayichen_uranus_bigtts', name: 'Quentin', lang: 'EN/ZH', gender: 'M' },
  { id: 'zh_male_shaonianzixin_uranus_bigtts', name: 'Jess', lang: 'Multi', gender: 'M' },
  { id: 'zh_male_liufei_uranus_bigtts', name: 'Felix', lang: 'ZH', gender: 'M' },
  { id: 'zh_male_sunwukong_uranus_bigtts', name: 'Monkey King', lang: 'ZH', gender: 'M' },
  { id: 'de_male_seven_uranus_bigtts', name: 'Sven', lang: 'DE', gender: 'M' },
  { id: 'fr_male_usseau_uranus_bigtts', name: 'Usseau', lang: 'FR', gender: 'M' },
  { id: 'es_male_felipe_uranus_bigtts', name: 'Felipe', lang: 'ES', gender: 'M' },
  { id: 'id_male_han_uranus_bigtts', name: 'Han', lang: 'ID', gender: 'M' },
  { id: 'pt_male_martins_uranus_bigtts', name: 'Martins', lang: 'PT', gender: 'M' },
  { id: 'it_male_enzo_uranus_bigtts', name: 'Enzo', lang: 'IT', gender: 'M' },
  { id: 'kr_male_shane_uranus_bigtts', name: 'Shane', lang: 'KO', gender: 'M' },
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi', lang: 'Multi', gender: 'F' },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: 'Mindy', lang: 'Multi', gender: 'F' },
  { id: 'zh_female_yingyujiaoxue_uranus_bigtts', name: 'Jean', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_mizai_uranus_bigtts', name: 'Mabel', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_jitangnv_uranus_bigtts', name: 'Nadia', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_meilinvyou_uranus_bigtts', name: 'Opal', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_liuchangnv_uranus_bigtts', name: 'Pearl', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_vivo_uranus_bigtts', name: 'Vienna', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_xiaoai_uranus_bigtts', name: 'Alina', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_cancan_uranus_bigtts', name: 'Corinne', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: 'Esther', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', name: 'Freya', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: 'Gigi', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_peiqi_uranus_bigtts', name: 'Holly', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_xiaoxue_uranus_bigtts', name: 'Lyla', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_yuanqi_uranus_bigtts', name: 'Daisy', lang: 'EN/ZH', gender: 'F' },
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', name: 'Celeste', lang: 'ZH', gender: 'F' },
  { id: 'zh_female_kefunvsheng_uranus_bigtts', name: 'Tracy', lang: 'ES/ZH', gender: 'F' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', name: 'Pinky', lang: 'Multi', gender: 'F' },
  { id: 'zh_female_kiwi_uranus_bigtts', name: 'Sweety', lang: 'JA/ES', gender: 'F' },
  { id: 'zh_female_sajiaoxuemei_uranus_bigtts', name: 'Sandy', lang: 'ES/ZH', gender: 'F' },
  { id: 'zh_female_sophie_uranus_bigtts', name: 'Sophie', lang: 'EN/ZH', gender: 'F' },
  { id: 'jp_female_minimi_uranus_bigtts', name: 'Minimi', lang: 'JA', gender: 'F' },
]
const EMOTIONS = ['', 'neutral', 'happy', 'sad', 'angry', 'surprised', 'excited'] as const

// Seedream needs ≥ 3,686,400 px for an exact size; each ratio maps to a 2K-class
// pixel size that clears that floor.
const RATIOS: Record<string, string> = {
  '1:1': '2048x2048',
  '16:9': '2560x1440',
  '9:16': '1440x2560',
  '4:3': '2304x1728',
  '3:4': '1728x2304',
  '3:2': '2400x1600',
  '2:3': '1600x2400',
}
// 4K-class exact sizes for Seedream 5.0 LITE. Lite's pixel window is
// [2560×1440 = 3,686,400 , 4096×4096 = 16,777,216] with aspect in [1/16, 16]
// (image-seedream.md §2) — every entry below sits inside it. Pro caps at ~4.62 MP,
// which is why 4K is offered on Lite only (the backend clamps it down anyway).
const RATIOS_4K: Record<string, string> = {
  '1:1': '4096x4096',
  '16:9': '3840x2160',
  '9:16': '2160x3840',
  '4:3': '3456x2592',
  '3:4': '2592x3456',
  '3:2': '3600x2400',
  '2:3': '2400x3600',
}
const RATIO_KEYS = ['auto', ...Object.keys(RATIOS)]

/** Píxeles de la clase 2K / 4K. 2K = 2048², que cabe a la vez bajo el techo de Pro
 *  (4,624,220) y sobre el suelo de Lite (3,686,400); 4K = 4096², sólo Lite. Son los mismos
 *  presupuestos que las tablas RATIOS/RATIOS_4K ya usan a mano. */
const PIXEL_BUDGET = { '2K': 2048 * 2048, '4K': 4096 * 4096 } as const

/** "Auto": el tamaño exacto WxH que respeta la proporción de la imagen FUENTE.
 *
 *  Seedream no tiene un "sigue la proporción de la referencia" — su `size` es un tier (y
 *  entonces infiere la proporción del prompt) o un WxH exacto; el único `auto` documentado
 *  es para descomposición en capas (tutorial oficial 5.0 pro). Así que se mide la fuente y
 *  se calcula el WxH a su proporción, escalado al presupuesto de la calidad elegida, con
 *  lados múltiplo de 16 y aspecto dentro de [1/16, 16] (image-seedream.md §2). El backend
 *  conserva su recorte como red de seguridad. */
const sizeForSource = (w: number, h: number, quality: '2K' | '4K'): string => {
  const r = Math.min(16, Math.max(1 / 16, w / h))
  const budget = PIXEL_BUDGET[quality]
  const round16 = (n: number) => Math.max(16, Math.round(n / 16) * 16)
  let tw = round16(Math.sqrt(budget * r))
  let th = round16(Math.sqrt(budget / r))
  // Redondear AL MÁS CERCANO puede cruzar el presupuesto por unos píxeles (medido: 3:4 a
  // 4K salía 3552x4736 = 16,822,272 px, 45 K por encima del techo de Lite). Se baja de
  // 16 en 16 el lado mayor hasta caber — la proporción apenas se mueve.
  while (tw * th > budget) { if (tw >= th) tw -= 16; else th -= 16 }
  return `${tw}x${th}`
}

/** Dimensiones reales de una referencia (data URI o URL) — el navegador las da. */
const measureImage = (url: string): Promise<{ w: number; h: number } | null> =>
  new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = url.startsWith('/') ? serveUrl(url) : url
  })

/** Gallery filter tabs. Icons for the kinds (the sidebar is only 224px wide), text for All. */
const GALLERY_TABS = [
  { id: 'all' as const,   label: 'All', icon: null,       title: 'Everything' },
  { id: 'image' as const, label: 'Img', icon: ImageIcon,  title: 'Images' },
  { id: 'video' as const, label: 'Vid', icon: Film,       title: 'Videos' },
  { id: 'audio' as const, label: 'Aud', icon: Music,      title: 'Audio' },
]

const VIDEO_MODEL = 'Seedance 2.0'
/** The three generation modes, in the order the dropdown lists them. */
const GEN_MODES = [
  { id: 'image' as const, label: 'AI Image', icon: Sparkles },
  { id: 'video' as const, label: 'AI Video', icon: Film },
  // "AI Audio", not "AI Voice": with Seed Audio's scene mode this renders score, sound
  // effects and ambience as well as speech, so the old label undersold it.
  { id: 'voice' as const, label: 'AI Audio', icon: Music },
]
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p', '4k'] as const
/** Ceilings from the live ModelArk model list (read 2026-09-04): base 2.0 renders up to
 *  4k, 2.5 up to 1080p (10-bit), Fast and Mini stop at 720p — which is why the picker
 *  filters instead of letting a render fail. The backend enforces the same ceiling
 *  before the call (byteplus_generative._MODEL_MAX_RESOLUTION). */
/** `max` is the resolution ceiling; `maxSecs` the clip-length ceiling; `refs` the
 *  multimodal reference budget. All three differ per model and the backend enforces
 *  them again (byteplus_generative._MODEL_CAPS) — this table exists so the UI never
 *  OFFERS a combination the vendor would reject. */
/** Reference budget for a tier, READ from the shared per-model helpers rather than written
 *  out again here. The counts were duplicated: lib/segments already owned them for the
 *  pipeline, and a second table in Studio is how the two silently stop agreeing after a
 *  model changes. Verified against the live API 2026-08-12 — 9 reference images is accepted
 *  on 2.0 and 10 is refused with "expected at most 9 reference images but got 10 instead". */
const refBudget = (model: string) => ({
  images: maxImageRefsFor(model), videos: maxVideoRefsFor(model), audios: maxAudioRefsFor(model),
})
const VIDEO_TIERS = [
  { id: 'base' as const, label: 'Seedance 2.0', hint: 'Full quality · up to 4K', max: '4k', maxSecs: 15, refs: refBudget('base') },
  { id: 'fast' as const, label: 'Seedance 2.0 Fast', hint: 'Quicker · up to 720p', max: '720p', maxSecs: 15, refs: refBudget('fast') },
  { id: 'mini' as const, label: 'Seedance 2.0 Mini', hint: 'Cheapest · up to 720p', max: '720p', maxSecs: 15, refs: refBudget('mini') },
  // Opt-in: 30 s in a single shot and a 50-material reference budget, up to 1080p — 4k
  // is still base 2.0 only, which is why Final Cut's 4k export stays there.
  { id: 'v25' as const, label: 'Seedance 2.5', hint: '30s clips · 50 refs · up to 1080p', max: '1080p', maxSecs: 30, refs: refBudget('v25') },
]
/** Seedream 4.0–5.0 ingest up to 14 reference images in one pass (image-seedream §2), with a
 *  hard cap of input references + generated images ≤ 15. Studio allowed 4 — not a documented
 *  limit of anything, just a number nobody revisited. */
const SEEDREAM_MAX_REFS = 14
/** Seedream's real ceiling is on refs + generated TOGETHER, so a big reference set costs
 *  batch slots. Enforced where the batch size is chosen, not silently truncated. */
const SEEDREAM_MAX_REFS_PLUS_IMAGES = 15
type VidTier = typeof VIDEO_TIERS[number]['id']
const tierOf = (t: string) => VIDEO_TIERS.find((x) => x.id === t) ?? VIDEO_TIERS[0]
const tierMax = (t: string) => tierOf(t).max
/** Clip-length ceiling for a tier: 15 s on the 2.0 family, 30 s on 2.5. */
const tierMaxSecs = (t: string) => tierOf(t).maxSecs
/** Resolutions a tier can actually deliver. */
const resolutionsFor = (t: string) =>
  VIDEO_RESOLUTIONS.slice(0, VIDEO_RESOLUTIONS.indexOf(tierMax(t) as typeof VIDEO_RESOLUTIONS[number]) + 1)
/** 10-bit outputs: 4k on base 2.0 and 1080p on 2.5 (live model list). Chrome/Firefox
 *  show a black frame for 10-bit HEVC, so both the picker and the card say so. */
const isTenBit = (tier: string, res: string) => res === '4k' || (res === '1080p' && tier === 'v25')

// Studio Upscale — AI MediaKit Video Enhancement (picker values in lib/upscale.ts).
/** An upscaled card is a MediaKit output, not a Seedance render: nothing to regenerate
*  or re-edit, and no trusted last frame for Extend/Edit (video-seedance §7). */
const isUpscaled = (it: StudioItem) => Boolean(it.params?.upscale)
/** How long the Studio keeps watching the disk for a take whose request already died, and
 *  how often. Just past the server's own ~70-minute render ceiling — see awaitTakeOnDisk. */
const TAKE_WAIT_MS = 75 * 60_000
const TAKE_POLL_MS = 15_000
const isWaitOut = (msg: string) => /timeout|timed out|network error|aborted|socket hang up|ECONNRESET/i.test(msg)
// A stable empty list for the selector: a fresh [] on every read is the getSnapshot loop.
const EMPTY_PENDING: PendingUpscale[] = []
// The video card's button styles, in one place: a 28 px utility button (icon-only unless
// the word is the meaning) and a segment of the transform control (no border of its own —
// the group carries it, and `divide-x` draws the seams).
const UTIL_BTN = 'flex items-center justify-center h-7 min-w-7 px-1.5 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary hover:border-text-dim whitespace-nowrap'
const SEG_BTN = 'flex items-center gap-1 h-7 px-2.5 text-[11px] text-cyan hover:bg-cyan/15 whitespace-nowrap'
const VIDEO_RATIOS = [
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '1:1', value: '1:1' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
  { label: '21:9', value: '21:9' },
  { label: 'Adaptive', value: 'adaptive' },
] as const
type VidMode = 't2v' | 'i2v' | 'first_last' | 'multimodal'
const VIDEO_MODES: { id: VidMode; label: string; refs: number }[] = [
  { id: 't2v', label: 'Text→Video', refs: 0 },
  { id: 'i2v', label: 'Image→Video', refs: 1 },
  { id: 'first_last', label: 'First+Last', refs: 2 },
  { id: 'multimodal', label: 'Multimodal', refs: 9 },
]
/** Image references a mode accepts. Fixed for the frame modes (1 first frame, 2 for
 *  first+last), but MULTIMODAL is per-model — 9 on the 2.0 family, 30 on 2.5 — so it is
 *  read from the tier, not from the mode table. */
const vidModeRefs = (m: VidMode, tier: string = 'base') =>
  m === 'multimodal' ? tierOf(tier).refs.images : (VIDEO_MODES.find((x) => x.id === m)?.refs ?? 0)

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const serveUrl = (p: string) => `${API_BASE}/api/asset/serve?path=${encodeURIComponent(p)}`

const nanoid = () => Math.random().toString(36).slice(2, 9)

/** Length of a media reference in seconds, or 0 when the browser cannot read it. Used to
 *  police the COMBINED duration budget, which the per-type count ceilings do not cover.
 *  Returns 0 rather than throwing so an unreadable clip weakens the check instead of
 *  blocking a generation on a metadata quirk. */
const mediaSeconds = (url: string, kind: 'video' | 'audio') => new Promise<number>((res) => {
  const el = kind === 'video' ? document.createElement('video') : new Audio()
  el.onloadedmetadata = () => res(Number.isFinite(el.duration) ? el.duration : 0)
  el.onerror = () => res(0)
  el.src = url
})
const fileToDataUri = (file: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(new Error('read failed'))
    r.readAsDataURL(file)
  })
const pad = (n: number) => String(n).padStart(2, '0')
const fmtDate = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const ratioOf = (it: StudioItem) => String(it.params?.ratio ?? '1:1')
/** "m:ss" since a timestamp, ticking once a second. A pending card that shows no time
 *  looks hung after the first minute; Professional 8K legitimately takes many. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return <span className="font-mono text-text-dim">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}
/** Regenerate/Refine must reuse the engine + size the item was made with, not whatever
 *  the composer happens to be set to now. */
const modelOf = (it: StudioItem): 'pro' | 'lite' =>
  (it.params?.model === 'lite' || /lite/i.test(String(it.params?.modelId ?? ''))) ? 'lite' : 'pro'
const qualityOf = (it: StudioItem): '2K' | '4K' => (it.params?.quality === '4K' ? '4K' : '2K')
/** El WxH con el que se hizo el ítem (Auto lo guarda resuelto), y su formato. */
const sizeOf = (it: StudioItem): string | undefined => (typeof it.params?.size === 'string' ? it.params.size : undefined)
const formatOf = (it: StudioItem): 'png' | 'jpeg' => (it.params?.format === 'jpeg' ? 'jpeg' : 'png')

/** Recover the DISK path behind a persisted Studio url (`/api/asset/serve?path=<abs>`).
 *  Items generated before videoLocalPath existed only carry that served url, and both
 *  Extend and Edit need a real path: an empty video_path made Extend fail with "could
 *  not read the shot's last frame", and made Edit hand BytePlus a localhost url it
 *  cannot fetch ("content[1].video_url … resource download failed", 2026-07-27). */
const diskPathOf = (url: string | null | undefined): string => {
  if (!url || url.startsWith('data:')) return ''
  try {
    const u = new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
    return u.pathname.endsWith('/api/asset/serve') ? (u.searchParams.get('path') ?? '') : ''
  } catch { return '' }
}
// Grow a textarea to fit its content (CSS max-height then clamps + scrolls).
const autoGrow = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }

interface RefImg { id: string; url: string }
interface MediaRef { id: string; url: string; name: string }   // video / audio reference (multimodal)
interface PendingGen { id: string; kind: 'image' | 'video' | 'audio'; prompt: string; model: string; ratio: string; count: number; refCount: number }

export function StudioView() {
  const items = useStudioStore((s) => s.items)
  const addItem = useStudioStore((s) => s.addItem)
  const patchItem = useStudioStore((s) => s.patchItem)
  const removeItem = useStudioStore((s) => s.removeItem)
  const pendingUpscales = useStudioStore((s) => s.pendingUpscales ?? EMPTY_PENDING)
  const addPendingUpscale = useStudioStore((s) => s.addPendingUpscale)
  const removePendingUpscale = useStudioStore((s) => s.removePendingUpscale)
  // Read-only link to the active project so generations land in {project}/Studio/…
  // and meter usage there. The Studio never WRITES to the pipeline store.
  const projectName = usePipelineStore((s) => s.projectName)
  const projectPath = usePipelineStore((s) => s.localFolderRoot)
  // Read-only: the pipeline endpoints reused by Extend / Edit take a StyleConfig, and
  // a Studio session with no project simply gets DEFAULT_STYLE. Nothing is written back.
  const style = usePipelineStore((s) => s.style)
  const removeImage = useStudioStore((s) => s.removeImage)
  const clearAll = useStudioStore((s) => s.clearAll)
  const clearKind = useStudioStore((s) => s.clearKind)

  const [genType, setGenType] = useState<GenType>('image')
  const [prompt, setPrompt] = useState('')
  const [refs, setRefs] = useState<RefImg[]>([])
  const [vidRefs, setVidRefs] = useState<MediaRef[]>([])   // multimodal video refs (0–3)
  const [audRefs, setAudRefs] = useState<MediaRef[]>([])   // multimodal audio refs (0–3)
  const [ratio, setRatio] = useState('auto')   // Auto: la proporción de la referencia
  const [imgFormat, setImgFormat] = useState<'png' | 'jpeg'>('png')
  const [count, setCount] = useState(1)
  const [showRatio, setShowRatio] = useState(false)
  // Video (Seedance 2.0)
  const [vidMode, setVidMode] = useState<VidMode>('multimodal')
  const [atMenu, setAtMenu] = useState<{ query: string; start: number } | null>(null)   // @-mention picker
  const [resolution, setResolution] = useState<string>('720p')
  const [vidTier, setVidTier] = useState<VidTier>('base')
  const [showTierMenu, setShowTierMenu] = useState(false)
  const [vidRatio, setVidRatio] = useState('16:9')
  const [duration, setDuration] = useState(5)
  // OFF by default (2026-08-11). ON asked Seedance to INVENT a soundtrack for shots that
  // carry no audio direction — a product still, a plate — and what it composed then tripped
  // its own copyright filter and killed the paid render. Audio is now opt-in, so it is
  // requested by someone who actually wants it.
  const [genAudio, setGenAudio] = useState(false)
  const [showVidMenu, setShowVidMenu] = useState<null | 'mode' | 'res' | 'ratio' | 'duration'>(null)
  // Voice (Seed TTS 2.0)
  // Image engine — Pro (best reference fidelity, ~2K ceiling) vs Lite (takes the 2K/3K/4K
  // presets, so it is the one that can actually deliver 4K). 4K is Lite-only; picking Pro
  // drops back to 2K because generate_image clamps it server-side regardless.
  const [imgModel, setImgModel] = useState<'pro' | 'lite'>('pro')
  const [imgQuality, setImgQuality] = useState<'2K' | '4K'>('2K')
  const [speaker, setSpeaker] = useState(VOICES[0].id)
  const [speechRate, setSpeechRate] = useState(0)
  const [emotion, setEmotion] = useState('')
  // Seed Audio 1.0 is a DIFFERENT product from the Seed TTS 2.0 above (own host +
  // key, audio-generation.md). It adds voice CLONING from a clip and voice DESIGN
  // from a portrait. Both engines stay selectable — TTS 2.0 keeps its voice roster.
  const [voiceEngine, setVoiceEngine] = useState<'tts2' | 'seedaudio'>('seedaudio')
  // Seed Audio can render a WHOLE SCENE — environment, score, SFX and who says what —
  // in one pass, not just a line of speech. 'scene' sends the prompt verbatim; 'voice'
  // keeps the original one-line behaviour.
  const [audioMode, setAudioMode] = useState<'voice' | 'scene'>('voice')
  const [audioMultilingual, setAudioMultilingual] = useState(true)   // 20 langs + [s:s] timing
  const [audioSubtitles, setAudioSubtitles] = useState(false)        // word/sentence timestamps
  const [sceneRefs, setSceneRefs] = useState<Array<{ id: string; url: string; name: string }>>([])
  // ONE reference at a time: Seed Audio never accepts an image and an audio ref in
  // the same request (§5), so picking one clears the other.
  const [voiceRef, setVoiceRef] = useState<{ kind: 'audio' | 'image'; url: string; name: string } | null>(null)
  const [showVoiceMenu, setShowVoiceMenu] = useState<null | 'speaker' | 'emotion'>(null)
  const [voiceFilter, setVoiceFilter] = useState<'all' | 'F' | 'M'>('all')
  const [pendingGens, setPendingGens] = useState<PendingGen[]>([])   // concurrent in-flight generations
  const addPending = useCallback((p: PendingGen) => setPendingGens((q) => [...q, p]), [])
  const endPending = useCallback((gid: string) => setPendingGens((q) => q.filter((x) => x.id !== gid)), [])
  const [enhancing, setEnhancing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [refineFor, setRefineFor] = useState<string | null>(null)   // `${itemId}:${index}` being refined
  const [refineText, setRefineText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const refineTaRef = useRef<HTMLTextAreaElement>(null)
  const feedEndRef = useRef<HTMLDivElement>(null)
  const entryRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Feed = newest at the bottom (chat-style)
  const feed = useMemo(() => [...items].reverse(), [items])

  // Auto-scroll to the bottom on a new generation / when one starts; jump there on mount.
  const prevLen = useRef(items.length)
  useEffect(() => {
    if (items.length > prevLen.current || pendingGens.length) feedEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    prevLen.current = items.length
  }, [items.length, pendingGens.length])
  useEffect(() => { feedEndRef.current?.scrollIntoView() }, [])   // start at the newest

  // Keep the textareas sized to their content (incl. programmatic Enhance / Re-edit).
  useEffect(() => { autoGrow(promptRef.current) }, [prompt])
  useEffect(() => { autoGrow(refineTaRef.current) }, [refineText, refineFor])

  /** Reference images this composer may hold RIGHT NOW — per model and per mode, never a
   *  constant. Declared HERE, above the add handlers, because they are what it is for: a
   *  ceiling used only to render the strip while the code that accepts files kept its own
   *  literal is a ceiling that does nothing. */
  const maxRefs = genType === 'image' ? SEEDREAM_MAX_REFS
    : genType === 'video' ? vidModeRefs(vidMode, vidTier) : 0

  /** Batch sizes still available once the references have taken their share of Seedream's
   *  refs + generated ≤ 15. Never below 1: a full reference set must not leave the composer
   *  with no legal count at all. */
  const imgCountCeiling = Math.max(1, Math.min(4, SEEDREAM_MAX_REFS_PLUS_IMAGES - refs.length))
  // DERIVED, not an effect that writes state back: a count chosen before the references
  // were attached must not be submitted, and clamping in an effect both fights the user's
  // pick and trips react-hooks/set-state-in-effect.
  const effectiveCount = Math.min(count, imgCountCeiling)

  const addRefs = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    const picked = Array.from(files)
    const room = Math.max(0, maxRefs - refs.length)
    const next: RefImg[] = []
    for (const f of picked.slice(0, room)) {
      try { next.push({ id: nanoid(), url: await fileToDataUri(f) }) } catch { /* skip unreadable */ }
    }
    // NEVER drop silently. `4` was hardcoded here while the strip, the buttons and the
    // tooltips all read the real per-model budget, so dropping the 5th of 5 on a 2.5 take
    // that accepts 30 looked like a rendering bug — and the prompt still addressed the
    // reference that never arrived.
    if (picked.length > room) {
      setError(`${maxRefs} reference image${maxRefs === 1 ? '' : 's'} max here — kept ${room}, dropped ${picked.length - room}.`)
    }
    if (next.length) setRefs((r) => [...r, ...next].slice(0, maxRefs))
  }, [refs.length, maxRefs])

  // Seed Audio voice reference — ONE clip (clone) or ONE portrait (design). Kind is
  // derived from the file's MIME so the two channels can never be sent together.
  const voiceRefFileRef = useRef<HTMLInputElement>(null)
  const addVoiceRef = useCallback(async (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    const kind: 'audio' | 'image' = f.type.startsWith('image/') ? 'image' : 'audio'
    // Both channels cap at 10 MB (§5) — reject here instead of failing server-side.
    if (f.size > 10 * 1024 * 1024) {
      setError(`${f.name} is ${Math.round(f.size / 1024 / 1024)}MB — Seed Audio references must be under 10MB.`)
      return
    }
    try {
      setVoiceRef({ kind, url: await fileToDataUri(f), name: f.name })
      setError(null)
    } catch {
      setError('Could not read that file')
    }
  }, [])

  const addSceneRefs = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    const next: Array<{ id: string; url: string; name: string }> = []
    for (const f of Array.from(files)) {
      if (f.size > 10 * 1024 * 1024) { setError(`${f.name} is over the 10MB reference limit.`); continue }
      try { next.push({ id: nanoid(), url: await fileToDataUri(f), name: f.name }) } catch { /* skip */ }
    }
    if (next.length) setSceneRefs((r) => [...r, ...next].slice(0, 3))   // @Audio1..@Audio3
  }, [])

  // Multimodal video / audio references. Budget is PER MODEL — 3 each totalling ≤15 s on
  // the 2.0 family, 10 each totalling ≤30 s on 2.5 — so both the count and the seconds are
  // read from the tier. The `3` that used to be hardcoded here is what made 2.5's larger
  // budget unreachable even though the add buttons already offered it.
  const vidFileRef = useRef<HTMLInputElement>(null)
  const audFileRef = useRef<HTMLInputElement>(null)
  const addMediaRefs = useCallback(async (files: FileList | null, kind: 'video' | 'audio') => {
    if (!files?.length) return
    const cap = kind === 'video' ? maxVideoRefsFor(vidTier) : maxAudioRefsFor(vidTier)
    const cur = kind === 'video' ? vidRefs : audRefs
    const picked = Array.from(files)
    const room = Math.max(0, cap - cur.length)
    const next: MediaRef[] = []
    for (const f of picked.slice(0, room)) {
      try { next.push({ id: nanoid(), url: await fileToDataUri(f), name: f.name }) } catch { /* skip */ }
    }
    if (picked.length > room) {
      setError(`${cap} reference ${kind}${cap === 1 ? '' : 's'} max on ${tierOf(vidTier).label} — kept ${room}, dropped ${picked.length - room}.`)
    }
    if (!next.length) return
    if (kind === 'video') setVidRefs((r) => [...r, ...next].slice(0, cap))
    else setAudRefs((r) => [...r, ...next].slice(0, cap))
    // Durations, best-effort — an unreadable clip contributes 0 rather than blocking.
    try {
      const all = [...cur, ...next]
      const secs = await Promise.all(all.map((m) => mediaSeconds(m.url, kind)))
      const total = secs.reduce((n, s) => n + s, 0)
      const budget = refSecsFor(vidTier)
      // The COUNT ceiling says nothing about this: three 10-second clips is a legal count
      // on 2.0 and double its legal duration, and the 400 only arrives after submitting.
      if (total > budget + 0.05) {
        setError(`Reference ${kind}s total ${total.toFixed(1)}s — ${tierOf(vidTier).label} allows ${budget}s combined. Remove or shorten one.`)
      } else if (kind === 'audio' && secs.some((d, i) => i >= cur.length && d > 0 && d < 1.8)) {
        // Seedance rejects audio refs shorter than 1.8s — warn before they generate.
        setError('Audio reference is under 1.8s — Seedance needs ≥1.8s. Use a longer clip.')
      }
    } catch { /* duration check is best-effort */ }
  }, [vidRefs, audRefs, vidTier])

  // First+Last frame slots (index 0 = first, 1 = last; '' = empty slot)
  const slotFileRef = useRef<HTMLInputElement>(null)
  const slotTarget = useRef(0)
  const openSlot = useCallback((idx: number) => { slotTarget.current = idx; slotFileRef.current?.click() }, [])
  const onSlotFile = useCallback(async (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    try {
      const url = await fileToDataUri(f)
      const idx = slotTarget.current
      setRefs((p) => { const n = [...p]; while (n.length <= idx) n.push({ id: nanoid(), url: '' }); n[idx] = { id: nanoid(), url }; return n })
    } catch { /* skip */ }
  }, [])
  const clearSlot = useCallback((idx: number) => setRefs((p) => { const n = [...p]; if (n[idx]) n[idx] = { id: n[idx].id, url: '' }; return n }), [])

  // Switching video sub-mode clears refs (each mode means a different thing).
  const changeVidMode = useCallback((m: VidMode) => { setVidMode(m); setRefs([]); setVidRefs([]); setAudRefs([]); setAtMenu(null); setShowVidMenu(null) }, [])

  // Download CDN media to disk (Studio/Gallery) and return a stable served URL so
  // the gallery survives the 24h CDN window (and stays out of localStorage).
  const persistMedia = useCallback(async (url: string, kind: 'image' | 'video', meta?: { tokens?: number; resolution?: string }): Promise<string> => {
    const ctx = projectPath ? { project_name: projectName, project_path: projectPath } : { project_name: '_studio', project_path: '' }
    try {
      const { data } = await apiClient.post<{ local_path?: string }>(
        '/api/studio/save',
        { url, kind, ...ctx, tokens: meta?.tokens ?? 0, resolution: meta?.resolution ?? '' },
        { timeout: 180_000 },
      )
      return data.local_path ? serveUrl(data.local_path) : url
    } catch { return url }   // keep the CDN url if the save fails (still works for 24h)
  }, [projectName, projectPath])

  // Videos additionally need their DISK path and their own trusted last-frame kept, so
  // Extend can run long after the 24h CDN window (see StudioItem's trust fields).
  const persistVideo = useCallback(async (
    url: string, lastFrameUrl: string, meta?: { tokens?: number; resolution?: string; model?: string }, meter = true,
  ): Promise<{ served: string; localPath: string; lastFrameLocalPath: string }> => {
    const ctx = projectPath ? { project_name: projectName, project_path: projectPath } : { project_name: '_studio', project_path: '' }
    try {
      const { data } = await apiClient.post<{ local_path?: string; last_frame_local_path?: string }>(
        '/api/studio/save',
        // `model` is the tier key ('v25' | 'base' | 'fast' | 'mini'): the usage ledger
        // prices a render per model, and 2.5 costs 52 % more per token than 2.0.
        { url, kind: 'video', ...ctx, tokens: meta?.tokens ?? 0, resolution: meta?.resolution ?? '',
          model: meta?.model ?? '', last_frame_url: lastFrameUrl, meter },
        { timeout: 180_000 },
      )
      return {
        served: data.local_path ? serveUrl(data.local_path) : url,
        localPath: data.local_path ?? '',
        lastFrameLocalPath: data.last_frame_local_path ?? '',
      }
    } catch { return { served: url, localPath: '', lastFrameLocalPath: '' } }
  }, [projectName, projectPath])

  // Download via blob so the current tab never navigates away (a cross-origin
  // <a download> is ignored by the browser and just opens the url). Falls back to
  // a new tab if the fetch is blocked, so in-progress work is never lost.
  const downloadMedia = useCallback(async (url: string, filename: string) => {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error('fetch failed')
      const obj = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = obj; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(obj), 1000)
    } catch {
      window.open(url, '_blank', 'noopener')
    }
  }, [])

  // Core generation — reused by the prompt bar and by per-entry Regenerate.
  const runGeneration = useCallback(async (opts: { prompt: string; refImages: string[]; ratio: string; count: number; model: 'pro' | 'lite'; quality: '2K' | '4K'; prepare?: () => Promise<string>; format?: 'png' | 'jpeg'; size?: string }) => {
    let p = opts.prompt.trim()
    if (!p) return
    setError(null)
    const id = nanoid()
    // EL TAMAÑO, RESUELTO ANTES DE PEDIR. Un ítem regenerado trae el suyo (`opts.size`).
    // "Auto" con referencia mide la primera y calcula a su proporción; sin referencia no
    // hay de qué inferir y cae a 1:1, que era el default de siempre. Un preset va a su tabla.
    let size: string = opts.size ?? ''
    if (!size) {
      if (opts.ratio === 'auto') {
        const dims = opts.refImages[0] ? await measureImage(opts.refImages[0]) : null
        size = dims ? sizeForSource(dims.w, dims.h, opts.quality)
                    : (opts.quality === '4K' ? RATIOS_4K['1:1'] : RATIOS['1:1'])
      } else {
        size = (opts.quality === '4K' ? RATIOS_4K[opts.ratio] : RATIOS[opts.ratio]) ?? '2K'
      }
    }
    const format = opts.format ?? 'png'
    addPending({ id, kind: 'image', prompt: p, model: imageModelLabel(opts.model === 'lite' ? 'lite' : 'pro'), ratio: opts.ratio, count: opts.count, refCount: opts.refImages.length })
    try {
      // A generation whose prompt still has to be WRITTEN (the Character Creator's sheets
      // ask the backend to assemble one first). It runs here, inside the pending card and
      // its error handling, so the caller can close its dialog the moment it is clicked
      // instead of holding the user in a modal through a two-minute LLM call.
      if (opts.prepare) p = (await opts.prepare()).trim()
      if (!p) throw new Error('No prompt returned')
      const { data } = await apiClient.post<{ urls?: string[]; model?: string; requested?: number; failed?: number }>(
        '/api/studio/image',
        {
          prompt: p,
          count: opts.count,
          size,
          output_format: format,
          model: opts.model,
          reference_images: opts.refImages.map((u) => ({ url: u, role: 'reference_image', weight: 0.7 })),
          // `?? ''` — localFolderRoot is `string | null`, and Studio's whole point is that
          // it works with NO pipeline project open, which is exactly when it is null.
          // StudioImageRequest declares `project_path: str = ""`, and a Pydantic default
          // only applies when the key is ABSENT: an explicit null is a 422 before the
          // request ever reaches Seedream. This was the ONE unguarded send left in the
          // frontend — every other call site already coalesces (see the video/voice paths
          // below and AssetGenerationView's `localFolderRoot ?? ''`).
          project_path: projectPath ?? '',
        },
        // Above the backend's own per-image ceiling (the SDK reads for 600s), so the
        // browser can never cut a batch that is still rendering server-side.
        { timeout: 900_000 },
      )
      const urls = (data.urls ?? []).filter(Boolean)
      if (!urls.length) throw new Error('No image returned')
      // Partial batches are reported, never passed off as a complete set.
      if (data.failed) setError(`${data.failed} of ${data.requested ?? urls.length + data.failed} variations failed — kept the ${urls.length} that rendered.`)
      addItem({
        id, kind: 'image', prompt: p, model: imageModelLabel(data.model),
        imageUrls: urls, videoUrl: null, audioUrl: null, posterUrl: urls[0] ?? null,
        refImages: opts.refImages, createdAt: Date.now(),
        params: { ratio: opts.ratio, size, format, count: opts.count, modelId: data.model ?? '', model: opts.model, quality: opts.quality },
      })
      setActiveId(id)
      // Persist to disk in the background, then swap to the stable served urls.
      void Promise.all(urls.map((u) => persistMedia(u, 'image'))).then((saved) => patchItem(id, { imageUrls: saved, posterUrl: saved[0] ?? null }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      endPending(id)
    }
  }, [addItem, patchItem, persistMedia, projectPath, addPending, endPending])

  // ── Video (Seedance 2.0) ────────────────────────────────────────────────────
  const insertToken = useCallback((token: string) => {
    setPrompt((p) => (p ? `${p.trimEnd()} ${token} ` : `${token} `))
    promptRef.current?.focus()
  }, [])

  // @-mention: detect "@query" before the caret as the user types.
  const onPromptChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setPrompt(val); autoGrow(e.target)
    const caret = e.target.selectionStart ?? val.length
    const m = val.slice(0, caret).match(/@(\w*)$/)
    const allowAt = genType === 'video' && vidMode === 'multimodal' && (refs.length + vidRefs.length + audRefs.length) > 0
    setAtMenu(m && allowAt ? { query: m[1], start: caret - m[0].length } : null)
  }, [refs.length, vidRefs.length, audRefs.length, genType, vidMode])

  // Replace the typed "@query" with the chosen reference token.
  const pickToken = useCallback((token: string) => {
    if (!atMenu) return
    setPrompt((p) => `${p.slice(0, atMenu.start)}${token} ${p.slice(atMenu.start + 1 + atMenu.query.length)}`)
    setAtMenu(null)
    promptRef.current?.focus()
  }, [atMenu])

  const runVideoGeneration = useCallback(async (opts: { prompt: string; mode: VidMode; images: string[]; videos?: string[]; audios?: string[]; ratio: string; resolution: string; duration: number; genAudio: boolean; tier?: VidTier }) => {
    const p = opts.prompt.trim()
    if (!p) return
    const need = vidModeRefs(opts.mode, opts.tier ?? 'base')
    if (opts.mode === 'i2v' && opts.images.length < 1) { setError('Image→Video needs 1 image'); return }
    if (opts.mode === 'first_last' && opts.images.length < 2) { setError('First+Last needs 2 images (first, last)'); return }
    if (opts.mode === 'multimodal' && (opts.images.length + (opts.videos?.length ?? 0) + (opts.audios?.length ?? 0) < 1)) {
      setError('Multimodal needs at least 1 reference (image, video, or audio)')
      return
    }
    setError(null)
    const id = nanoid()
    addPending({ id, kind: 'video', prompt: p, model: VIDEO_TIERS.find((t) => t.id === (opts.tier ?? 'base'))!.label, ratio: opts.ratio, count: 1, refCount: Math.min(opts.images.length, need || opts.images.length) })
    type Poll = { status: string; video_url?: string; last_frame_url?: string; error?: string; tokens?: number; resolution?: string }
    // Submit + poll as ONE unit so the audio-filter retry below re-runs the whole thing
    // instead of duplicating the polling loop next to it.
    const submitAndPoll = async (generateAudio: boolean): Promise<Poll> => {
      const { data } = await apiClient.post<{ task_id?: string }>(
        '/api/studio/video',
        { prompt: p, mode: opts.mode, images: opts.images, videos: opts.videos ?? [], audios: opts.audios ?? [], ratio: opts.ratio, resolution: opts.resolution, duration: opts.duration, generate_audio: generateAudio, model: opts.tier ?? 'base' },
        { timeout: 60_000 },
      )
      const taskId = data.task_id
      if (!taskId) throw new Error('No task id returned')
      // Poll until the render finishes (videos take minutes).
      const deadline = Date.now() + 12 * 60_000
      let done: Poll | null = null
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000))
        try {
          const { data: s } = await apiClient.get<Poll>(`/api/studio/video/${taskId}`)
          if (s.status === 'completed') { done = s; break }
          if (s.status === 'failed') { done = { status: 'failed', error: s.error || 'Video generation failed' }; break }
        } catch { /* transient — keep polling */ }
      }
      if (!done?.video_url) throw new Error(done?.error || 'Video timed out')
      return done
    }

    try {
      // Seedance rejects the score IT was about to invent and takes the whole paid render
      // down with it. Studio used to resubmit once with audio OFF, on the theory that a mute
      // clip was what a shot with no audio direction wanted anyway. That theory does not
      // survive a TALKING shot: the dialogue is the entire point, and the silent take was
      // landing in the gallery looking like the result.
      //
      // Retry with audio ON instead, because the block is a lottery and not a property of
      // the prompt. Measured 2026-09-02 on one talking close-up, audio ON throughout:
      //   27hv5 · qz24g · rvrrf   original prose prompt          → blocked
      //   d6tkt                   BytePlus 2.5 {} dialogue form  → blocked
      //   k96nv                   same, on Seedance 2.0 base     → blocked
      //   7jjpg                   single-audio-source wording    → PASSED
      // 5 of 6 blocked. And the one that passed was NOT quiet: a blind transcribe of its
      // silent head and tail (negative controls: white noise → "NONE", reversed speech →
      // gibberish, so the reader is not guessing) reports sustained strings and piano, and
      // its spectral flatness is 0.20 against 0.85 for pure noise. Seedance composed a score
      // even when the prompt declared one sound source — the wording never stopped the
      // music, it only changed whether the filter happened to flag it. So no prompt edit
      // fixes this and resubmitting the SAME request is the only lever that works.
      let done: Poll | null = null
      for (let attempt = 1; attempt <= 1 + AUDIO_FILTER_RETRIES; attempt++) {
        try {
          done = await submitAndPoll(opts.genAudio)
          break
        } catch (e) {
          const msg = e instanceof Error ? e.message : ''
          const last = attempt === 1 + AUDIO_FILTER_RETRIES
          // Only the audio filter is retried. Anything else — capacity, a rejected input
          // image, a timeout — repeats identically, so a retry would just burn wall clock.
          if (!opts.genAudio || !isAudioFilterBlock(msg) || last) throw e
          setError(`Seedance blocked the audio it generated — attempt ${attempt} of `
            + `${1 + AUDIO_FILTER_RETRIES} failed, resubmitting with audio still on…`)
        }
      }
      const ok = done!
      const dv = ok.video_url!
      const dp = ok.last_frame_url
      const dtok = ok.tokens
      const dres = ok.resolution || opts.resolution
      addItem({
        id, kind: 'video', prompt: p, model: VIDEO_TIERS.find((t) => t.id === (opts.tier ?? 'base'))!.label,
        imageUrls: [], videoUrl: dv, audioUrl: null, posterUrl: dp || opts.images[0] || null,
        refImages: opts.images, createdAt: Date.now(),
        // No silent downgrade can happen any more, so this is simply what was asked for.
        params: { mode: opts.mode, ratio: opts.ratio, resolution: opts.resolution, duration: opts.duration, tier: opts.tier ?? 'base', genAudio: opts.genAudio },
        // Keep Seedance's own last-frame url for Extend — VERBATIM while it lives.
        lastFrameUrl: dp || null,
      })
      setActiveId(id)
      setError(null)
      // Persist to disk in the background (+ meter video usage), then swap urls. The
      // clip's RAW last-frame is saved alongside so Extend still has a trusted frame
      // after the CDN url expires.
      void (async () => {
        const v = await persistVideo(dv, dp || '', { tokens: dtok, resolution: dres, model: opts.tier ?? 'base' })
        const poster = dp ? await persistMedia(dp, 'image') : undefined
        patchItem(id, {
          videoUrl: v.served, videoLocalPath: v.localPath || null,
          lastFrameLocalPath: v.lastFrameLocalPath || null,
          ...(poster ? { posterUrl: poster } : {}),
        })
      })()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Video generation failed'
      // Name the audio filter for what it is. The operator needs to know that NOTHING was
      // saved (so they are not hunting the gallery for a clip that does not exist) and that
      // turning Audio off is a deliberate choice to render the shot silent, not a fix.
      setError(isAudioFilterBlock(msg)
        ? 'Seedance blocked the audio it generated (copyright filter) and failed the whole render. '
          + 'Nothing was saved. Re-run it, or rewrite the audio direction — turning Audio off '
          + 'renders the shot silent, which for a line of dialogue is not the shot.'
        : msg)
    } finally {
      endPending(id)
    }
  }, [addItem, patchItem, persistMedia, persistVideo, addPending, endPending])

  // ── C: Extend / Edit a generated video ──────────────────────────────────────
  // Both reuse the PIPELINE endpoints (pipelineApi.extendShot / editShot) rather than
  // re-implementing them: those carry the tuned biometric-trust chain — Extend hands
  // Seedance the ORIGINAL last_frame_url verbatim while it is alive, falls back to the
  // RAW .lastframe.png, and only then to an ffmpeg grab (which breaks trust); Edit
  // re-hosts the source clip byte-identically to R2 as a reference_video. Duplicating
  // that logic here is how the two copies would silently diverge (video-seedance §7).
  // Results land as NEW gallery items (params.parentId) — the source is never touched.

  // How long a clip IS, for a call that will be paid for. `Number(it.params?.duration ?? 5)`
  // stood at every site that needed one, and it is wrong twice over: `?? 5` invents footage
  // for an item that never recorded a length, and `params.duration` is inherited verbatim by
  // an Extend result (the spread in extendVideo), so editing a 4 s continuation of a 10 s
  // source asked Seedance — and the account — for 10 s.
  // The clip on disk is the only thing that knows. /api/asset/duration is the same ffprobe
  // Stage 6 sizes a paid re-render with (renderLengthFor), so Studio and the export agree.
  // null means unknown, and unknown means nothing is sent: a guessed length is footage the
  // user pays for and then has to cut. `params.duration` survives only as the length that was
  // ASKED for, for a clip not yet on disk — and never for an Extend result, whose recorded
  // number may be its source's.
  const paidClipSeconds = useCallback(async (it: StudioItem): Promise<number | null> => {
    const path = it.videoLocalPath || diskPathOf(it.videoUrl)
    const probed = path ? await pipelineApi.mediaDuration(path).catch(() => null) : null
    if (probed && probed > 0) return probed
    const asked = Number(it.params?.duration ?? 0)
    return it.params?.extendedBy === undefined && asked > 0 ? asked : null
  }, [])

  /** A dead request is not a dead render. Extend and Edit are full Seedance renders that
   *  routinely outlive the client's 10-minute ceiling — the browser reports "timeout of
   *  600000ms exceeded" while the SERVER polls on to its own ~70-minute limit, saves the
   *  take under Shots/<clipId>/ and marks the registry complete. Losing the browser's answer
   *  used to lose the take: paid footage on disk that the gallery never showed. So a timeout
   *  (or a dropped connection) is not the end here — it is when we start watching the disk
   *  for what has already been paid for. Read-only; never renders, never pays twice. */
  const awaitTakeOnDisk = useCallback(async (clipId: string) => {
    const deadline = Date.now() + TAKE_WAIT_MS
    // Asked at once, because the take is usually ALREADY there: the client's ceiling and
    // the render's end are minutes apart at most, and the server saves the moment it has
    // the file. Only then does this settle into its slow watch.
    for (;;) {
      try {
        const d = await pipelineApi.recoverExtend({
          projectName: projectName || '_studio', projectPath: projectPath ?? '', clipId,
        })
        if (d.video_path) return d
      } catch { /* transient — keep watching */ }
      if (Date.now() >= deadline) return null
      await new Promise((r) => setTimeout(r, TAKE_POLL_MS))
    }
  }, [projectName, projectPath])

  const extendVideo = useCallback(async (it: StudioItem, extraSeconds: number, concat: boolean, note: string) => {
    // Older items only carry the served url — recover the disk path from it.
    const videoPath = it.videoLocalPath || diskPathOf(it.videoUrl)
    if (!videoPath) { setError('This clip is not saved to disk yet — wait for the save to finish, then Extend.'); return }
    setError(null)
    const id = nanoid()
    addPending({ id, kind: 'video', prompt: note || it.prompt, model: VIDEO_EXTEND_MODEL, ratio: ratioOf(it), count: 1, refCount: 0 })
    try {
      const data = await pipelineApi.extendShot({
        shotId: `Studio_${it.id}`, clipId: `Studio_${id}`,
        videoPath, extraSeconds, concat, note: note.trim(),
        projectName: projectName || '_studio', projectPath: projectPath ?? '',
        style, ratio: ratioOf(it), resolution: String(it.params?.resolution ?? '1080p'),
        // Both trust channels — the backend picks the live one, in that order. A clip
        // from before this feature has neither, so it falls back to an ffmpeg grab
        // (works, but the frame is re-encoded → no biometric trust for faces).
        lastFrameUrl: it.lastFrameUrl ?? '',
        lastFrame: it.lastFrameLocalPath ?? diskPathOf(it.posterUrl),
      })
      if (!data.video_path) throw new Error('Extend returned no clip')
      addItem({
        id, kind: 'video', prompt: it.prompt, model: VIDEO_EXTEND_MODEL,
        imageUrls: [], videoUrl: serveUrl(data.video_path), audioUrl: null,
        posterUrl: data.thumbnail_path ? serveUrl(data.thumbnail_path) : it.posterUrl,
        refImages: [], createdAt: Date.now(),
        // `duration` LAST, after the spread: the source's length rode in with `...it.params`
        // and a continuation is not its source. data.duration is the backend's ffprobe of the
        // file it just saved — the continuation alone, or source+continuation under concat.
        params: { ...(it.params ?? {}), parentId: it.id, extendedBy: data.added_seconds, concat, extendNote: note.trim(),
          duration: data.duration > 0 ? data.duration : undefined },
        videoLocalPath: data.video_path,
        // The continuation persists its OWN Seedance last-frame → it stays extendable.
        lastFrameUrl: data.last_frame_url || null,
        lastFrameLocalPath: data.last_frame_local_path || null,
      })
      setActiveId(id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Extend failed'
      if (!isWaitOut(msg)) { setError(msg); return }
      setError('The continuation is still rendering on the server — this card fills in when the take lands. You can keep working.')
      const d = await awaitTakeOnDisk(`Studio_${id}`)
      if (!d) { setError('The continuation never landed — check the backend log for this task.'); return }
      addItem({
        id, kind: 'video', prompt: it.prompt, model: VIDEO_EXTEND_MODEL,
        imageUrls: [], videoUrl: serveUrl(d.video_path), audioUrl: null,
        posterUrl: d.thumbnail_path ? serveUrl(d.thumbnail_path) : it.posterUrl,
        refImages: [], createdAt: Date.now(),
        params: { ...(it.params ?? {}), parentId: it.id, extendedBy: d.added_seconds, concat, extendNote: note.trim(),
          duration: d.duration > 0 ? d.duration : undefined },
        videoLocalPath: d.video_path,
        // Recovered from disk, so only the SAVED frame is available — the CDN url the
        // render answered with is gone with the response that carried it.
        lastFrameUrl: null,
        lastFrameLocalPath: d.last_frame_local_path || null,
      })
      setActiveId(id)
      setError(null)
    } finally {
      endPending(id)
    }
  }, [addItem, addPending, endPending, projectName, projectPath, style, awaitTakeOnDisk])

  const editVideo = useCallback(async (it: StudioItem, note: string) => {
    if (!note.trim()) { setError('Describe the change you want in the clip.'); return }
    // The disk copy is what gets re-hosted byte-identically to R2; the served url is a
    // LOCALHOST address BytePlus cannot fetch, so never fall back to it.
    const videoPath = it.videoLocalPath || diskPathOf(it.videoUrl)
    if (!videoPath) { setError('This clip is not saved to disk yet — wait for the save to finish, then Edit.'); return }
    // A v2v edit re-renders THIS clip, so its length is the clip's own — measured, never
    // assumed. The backend clamps whatever arrives to Seedance's 4-15 s window and would
    // have turned a missing number into 5 s of paid footage without ever saying so.
    const secs = await paidClipSeconds(it)
    if (secs === null) {
      setError('This clip will not probe, so an edit would have to guess how long to make it — and the guess is footage you pay for. Re-generate the clip, then Edit.')
      return
    }
    setError(null)
    const id = nanoid()
    addPending({ id, kind: 'video', prompt: note, model: VIDEO_EDIT_MODEL, ratio: ratioOf(it), count: 1, refCount: 0 })
    try {
      const data = await pipelineApi.editShot({
        shotId: `Studio_${it.id}`, clipId: `Studio_${id}`,
        videoPath, videoUrl: '',
        note: note.trim(), duration: secs,
        projectName: projectName || '_studio', projectPath: projectPath ?? '',
        style, ratio: ratioOf(it), resolution: String(it.params?.resolution ?? '1080p'),
        generateAudio: true,
      })
      if (!data.video_path) throw new Error('Edit returned no clip')
      addItem({
        id, kind: 'video', prompt: `${it.prompt} — ${note.trim()}`, model: VIDEO_EDIT_MODEL,
        imageUrls: [], videoUrl: serveUrl(data.video_path), audioUrl: null,
        posterUrl: data.thumbnail_path ? serveUrl(data.thumbnail_path) : it.posterUrl,
        refImages: [], createdAt: Date.now(),
        // Same rule as Extend: `duration` after the spread. The clamp above can move it
        // (a 3.4 s clip comes back 4 s), so the take records what it IS, not what it was cut from.
        params: { ...(it.params ?? {}), parentId: it.id, editNote: note.trim(),
          duration: data.duration > 0 ? data.duration : secs },
        videoLocalPath: data.video_path,
        lastFrameUrl: data.last_frame_url || null,
        lastFrameLocalPath: data.last_frame_local_path || null,
      })
      setActiveId(id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Edit failed'
      if (!isWaitOut(msg)) { setError(msg); return }
      setError('The edit is still rendering on the server — this card fills in when the take lands. You can keep working.')
      const d = await awaitTakeOnDisk(`Studio_${id}`)
      if (!d) { setError('The edited take never landed — check the backend log for this task.'); return }
      addItem({
        id, kind: 'video', prompt: `${it.prompt} — ${note.trim()}`, model: VIDEO_EDIT_MODEL,
        imageUrls: [], videoUrl: serveUrl(d.video_path), audioUrl: null,
        posterUrl: d.thumbnail_path ? serveUrl(d.thumbnail_path) : it.posterUrl,
        refImages: [], createdAt: Date.now(),
        params: { ...(it.params ?? {}), parentId: it.id, editNote: note.trim(),
          duration: d.duration > 0 ? d.duration : secs },
        videoLocalPath: d.video_path,
        lastFrameUrl: null,
        lastFrameLocalPath: d.last_frame_local_path || null,
      })
      setActiveId(id)
      setError(null)
    } finally {
      endPending(id)
    }
  }, [addItem, addPending, endPending, paidClipSeconds, projectName, projectPath, style, awaitTakeOnDisk])

  // ── Voice (Seed TTS 2.0 · Seed Audio 1.0) ───────────────────────────────────
  const runVoiceGeneration = useCallback(async (opts: {
    text: string; speaker: string; speechRate: number; emotion: string
    engine: 'tts2' | 'seedaudio'; ref: { kind: 'audio' | 'image'; url: string; name: string } | null
    mode: 'voice' | 'scene'; multilingual: boolean; subtitles: boolean; sceneRefs: string[]
  }) => {
    const t = opts.text.trim()
    if (!t) return
    // Seed Audio's hard text cap (§4) — fail here rather than burn a request.
    const cap = opts.mode === 'scene' ? 3000 : 2048
    if (opts.engine === 'seedaudio' && t.length > cap) {
      setError(`Text is ${t.length} characters — the limit is ${cap}. Split it into shorter takes.`)
      return
    }
    setError(null)
    const id = nanoid()
    const model = opts.engine === 'seedaudio' ? (opts.mode === 'scene' ? `${AUDIO_MODEL} · scene` : AUDIO_MODEL) : VOICE_MODEL
    addPending({ id, kind: 'audio', prompt: t, model, ratio: '', count: 1, refCount: opts.ref ? 1 : 0 })
    try {
      const ctx = projectPath ? { project_name: projectName, project_path: projectPath } : { project_name: '_studio', project_path: '' }
      const common = {
        text: t, speaker: opts.speaker, format: 'mp3', sample_rate: 24000,
        speech_rate: opts.speechRate, emotion: opts.emotion, ...ctx,
      }
      const seedAudio = opts.engine === 'seedaudio'
      const { data } = await apiClient.post<{ local_path?: string; duration?: number; billed_seconds?: number; cost_usd?: number }>(
        seedAudio ? '/api/studio/audio' : '/api/studio/tts',
        seedAudio
          // Exactly one reference channel — the backend rejects both together.
          ? { ...common,
              mode: opts.mode, multilingual: opts.multilingual, subtitles: opts.subtitles,
              // Scene mode cites up to three clips as @Audio1..@Audio3, in this order.
              reference_audios: opts.mode === 'scene' ? opts.sceneRefs : [],
              reference_audio: opts.mode === 'scene' ? '' : (opts.ref?.kind === 'audio' ? opts.ref.url : ''),
              reference_image: opts.ref?.kind === 'image' ? opts.ref.url : '' }
          : common,
        { timeout: 120_000 },
      )
      const url = data.local_path ? serveUrl(data.local_path) : null
      if (!url) throw new Error('No audio returned')
      addItem({
        id, kind: 'audio', prompt: t, model,
        imageUrls: [], videoUrl: null, audioUrl: url, posterUrl: null,
        refImages: [], createdAt: Date.now(),
        params: { speaker: opts.speaker, engine: opts.engine, voiceRef: opts.ref?.name ?? '',
          audioMode: opts.mode, seconds: data.duration ?? 0, costUsd: data.cost_usd ?? 0 },
      })
      setActiveId(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Audio generation failed')
    } finally {
      endPending(id)
    }
  }, [addItem, projectName, projectPath, addPending, endPending])

  const generate = useCallback(() => {
    if (!prompt.trim()) return
    if (genType === 'voice') {
      void runVoiceGeneration({ text: prompt, speaker, speechRate, emotion, engine: voiceEngine, ref: voiceRef,
        mode: audioMode, multilingual: audioMultilingual, subtitles: audioSubtitles, sceneRefs: sceneRefs.map((r) => r.url) })
      setPrompt('')
      return
    }
    if (genType === 'image') {
      void runGeneration({ prompt, refImages: refs.map((r) => r.url).filter(Boolean), ratio, count: effectiveCount, model: imgModel, quality: imgQuality, format: imgFormat })
    } else {
      void runVideoGeneration({
        prompt, mode: vidMode, images: refs.map((r) => r.url).filter(Boolean),
        videos: vidRefs.map((r) => r.url), audios: audRefs.map((r) => r.url),
        ratio: vidRatio, resolution, duration, genAudio, tier: vidTier,
      })
    }
    setPrompt(''); setRefs([]); setVidRefs([]); setAudRefs([])   // clear the composer
  }, [genType, prompt, refs, vidRefs, audRefs, ratio, effectiveCount, runGeneration, vidMode, vidRatio, resolution, duration, genAudio, runVideoGeneration, vidTier, speaker, speechRate, emotion, runVoiceGeneration, voiceEngine, voiceRef, imgModel, imgQuality, imgFormat, audioMode, audioMultilingual, audioSubtitles, sceneRefs])

  // ── Per-image actions (one image at a time, never the whole batch) ──────────
  const loadComposer = useCallback((p: string, r: string, c: number, refImages: string[]) => {
    setGenType('image'); setPrompt(p); setRatio(r); setCount(c)
    setRefs(refImages.map((url) => ({ id: nanoid(), url })))
    promptRef.current?.focus()
    promptRef.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  // ── Edit with Pro (B): the SAME Seedream 5.0 Pro editor the pipeline uses in AG —
  // markup canvas, reference images and a free instruction, via /api/assets/edit.
  // Trust: the base is a Studio Seedream output on THIS account and rides byte-exact,
  // so the KYC-HIGH image-to-image exemption still covers it (t2i → i2i → i2v chain).
  // The result lands as a NEW gallery item (parentId → the source) so nothing is lost.
  const [proEditFor, setProEditFor] = useState<{ item: StudioItem; url: string } | null>(null)
  const [charCreatorOpen, setCharCreatorOpen] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [showEngineMenu, setShowEngineMenu] = useState(false)
  // Which still is being animated (image → Seedance i2v, straight from its card).
  const [animateFor, setAnimateFor] = useState<{ item: StudioItem; url: string } | null>(null)
  // Lightbox: Studio had no way to see a generation uncropped (mirrors AG's viewer).
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)
  // The gallery mixed every kind together. It is now filtered by kind; the FEED stays
  // chronological and mixed, since that is where you edit and regenerate.
  const [galleryKind, setGalleryKind] = useState<'all' | StudioKind>('all')
  const galleryItems = useMemo(
    () => (galleryKind === 'all' ? items : items.filter((i) => i.kind === galleryKind)),
    [items, galleryKind],
  )

  // Esc closes the full-size viewer. Registered only while it is open so it never
  // swallows Escape from the other panels.
  useEffect(() => {
    if (!zoomUrl) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomUrl(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomUrl])
  // C: which video card has its Extend / Edit panel open, plus that panel's inputs.
  const [vidActionFor, setVidActionFor] = useState<{ item: StudioItem; kind: 'extend' | 'edit' | 'upscale' } | null>(null)
  // Upscale picker state. Defaults are the everyday choice: 4K on Standard, HD style.
  const [upRes, setUpRes] = useState<UpRes>('4k')
  const [upTier, setUpTier] = useState<UpTier>('standard')
  const [upStyle, setUpStyle] = useState<UpStyle>('hd')
  const [upQuote, setUpQuote] = useState<{ usd: number; seconds: number } | null>(null)

  // The price BEFORE the submit. The vendor bills output minutes × a published
  // coefficient, and the output is as long as the input, so the clip's own length gives
  // the exact figure — the backend owns the table so it cannot drift from what is billed.
  useEffect(() => {
    if (vidActionFor?.kind !== 'upscale') return
    const src = vidActionFor.item.videoUrl || ''
    let alive = true
    void (async () => {
      const secs = await mediaSeconds(src, 'video')
      try {
        const { data } = await apiClient.post<{ usd: number }>('/api/studio/upscale/quote',
          { resolution: upRes, tier: upTier, duration_secs: secs, fps: 24 })
        if (alive) setUpQuote({ usd: data.usd, seconds: secs })
      } catch { if (alive) setUpQuote({ usd: -1, seconds: secs }) }
    })()
    return () => { alive = false }
  }, [vidActionFor, upRes, upTier])

  // Watch one upscale the server is working on. The SERVER owns the wait now (it polls
  // the vendor and writes the clip to disk itself), so this only asks how it is going —
  // no deadline of its own: yesterday's "Upscale timed out" was this loop giving up at
  // 30 minutes on a task the vendor went on to finish and bill. Resumed on mount for
  // every persisted pending upscale, so a reload changes nothing.
  const watchedRef = useRef<Set<string>>(new Set())
  const watchUpscale = useCallback(async (p: PendingUpscale) => {
    if (watchedRef.current.has(p.id)) return
    watchedRef.current.add(p.id)
    type Poll = { status: string; local_path?: string; filename?: string; resolution?: string; fps?: number; seconds?: number; usd?: number; elapsed?: number; error?: string }
    const ceiling = Date.now() + 6 * 60 * 60_000   // the server gives up at 6 h too
    try {
      let done: Poll | null = null
      while (Date.now() < ceiling) {
        try {
          const { data: st } = await apiClient.get<Poll>(`/api/studio/upscale/${p.taskId}`)
          if (st.status === 'completed' || st.status === 'failed') { done = st; break }
        } catch (e) {
          // An unknown task is gone for good (the ledger keeps finished ones a week).
          if (e instanceof Error && /Unknown upscale task/.test(e.message)) { done = { status: 'failed', error: e.message }; break }
        }
        await new Promise((r) => setTimeout(r, 5000))
      }
      if (!done) throw new Error('Upscale still running after 6 hours — check the backend log')
      if (done.status !== 'completed' || !done.local_path) throw new Error(done.error || 'Upscale failed')
      const res = done.resolution || p.params.resolution
      addItem({
        id: p.id, kind: 'video', prompt: p.prompt, model: p.model,
        imageUrls: [], videoUrl: serveUrl(done.local_path), audioUrl: null, posterUrl: p.posterUrl,
        refImages: [], createdAt: Date.now(),
        // `tier: 'upscale'` keeps the 10-bit playback note (a Seedance property) off
        // this card; `costUsd` is the real figure — output minutes × coefficient.
        params: { ratio: p.ratio, mode: 'upscale', tier: 'upscale', resolution: res, duration: done.seconds ?? 0,
          upscale: { ...p.params, scene: 'aigc' }, sourceId: p.sourceId,
          seconds: done.seconds ?? 0, costUsd: done.usd ?? 0 },
        videoLocalPath: done.local_path,
      })
      setActiveId(p.id)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upscale failed')
    } finally {
      removePendingUpscale(p.id)
      watchedRef.current.delete(p.id)
    }
  }, [addItem, removePendingUpscale])

  // Resume: whatever was pending when this tab last closed is still running (or done)
  // on the server. Runs once per pending id — watchedRef keeps a re-render from doubling it.
  useEffect(() => { pendingUpscales.forEach((p) => { void watchUpscale(p) }) }, [pendingUpscales, watchUpscale])

  // Upscale: AI MediaKit re-renders the clip at 2K/4K/8K (super-resolution, denoise,
  // colour). The source is the clip on DISK when we have it — the CDN url dies in ~24h
  // and the vendor downloads at task start — and the backend hosts it on R2 for the
  // task, then saves the result into the project's Studio/Videos itself.
  const runUpscale = useCallback(async (it: StudioItem) => {
    const source = it.videoLocalPath || it.videoUrl
    if (!source) { setError('This clip has no source to upscale'); return }
    const label = `AI MediaKit · ${UPSCALE_TIERS.find((t) => t.id === upTier)!.label} ${upRes.toUpperCase()}`
    const ctx = projectPath ? { project_name: projectName, project_path: projectPath } : { project_name: '_studio', project_path: '' }
    setError(null)
    try {
      const secs = await mediaSeconds(it.videoUrl || '', 'video')
      const { data } = await apiClient.post<{ task_id?: string }>(
        '/api/studio/upscale',
        { video: source, resolution: upRes, tier: upTier, scene: 'aigc', style: upStyle, duration_secs: secs, ...ctx },
        { timeout: 600_000 },   // the clip is hosted before the task is accepted
      )
      if (!data.task_id) throw new Error('No task id returned')
      addPendingUpscale({
        id: nanoid(), taskId: data.task_id, sourceId: it.id, prompt: it.prompt, model: label,
        ratio: ratioOf(it), posterUrl: it.posterUrl, params: { resolution: upRes, tier: upTier, style: upStyle },
        startedAt: Date.now(),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upscale failed')
    }
  }, [upRes, upTier, upStyle, projectName, projectPath, addPendingUpscale])
  const [extendSecs, setExtendSecs] = useState(5)          // Seedance clamps to [4,15]
  const [extendConcat, setExtendConcat] = useState(false)  // true → one longer joined clip
  const [extendNote, setExtendNote] = useState('')          // optional direction for the continuation
  const [vidEditNote, setVidEditNote] = useState('')

  const onProEditApplied = useCallback((src: StudioItem, edited: { url: string; localPath: string }) => {
    const url = edited.localPath ? serveUrl(edited.localPath) : edited.url
    if (!url) return
    const id = nanoid()
    addItem({
      id, kind: 'image', prompt: src.prompt, model: IMAGE_EDIT_MODEL,
      imageUrls: [url], videoUrl: null, audioUrl: null, posterUrl: url,
      refImages: [], createdAt: Date.now(),
      params: { ...(src.params ?? {}), parentId: src.id, edited: true },
    })
    setActiveId(id)
    setProEditFor(null)
  }, [addItem])

  // Re-edit: change the prompt, keep the reference images. One image (count 1).
  const reEditImage = useCallback((it: StudioItem) => {
    loadComposer(it.prompt, ratioOf(it), 1, it.refImages ?? [])
  }, [loadComposer])

  // Regenerate: one fresh image with the same prompt + settings.
  const regenerateImage = useCallback((it: StudioItem) => {
    void runGeneration({ prompt: it.prompt, refImages: it.refImages ?? [], ratio: ratioOf(it), count: 1, model: modelOf(it), quality: qualityOf(it), size: sizeOf(it), format: formatOf(it) })
  }, [runGeneration])

  // Refine: keep THIS image (as the reference) and apply an add/change instruction.
  const doRefine = useCallback((it: StudioItem, url: string) => {
    const instr = refineText.trim()
    if (!instr) return
    setRefineFor(null); setRefineText('')
    void runGeneration({ prompt: instr, refImages: [url], ratio: ratioOf(it), count: 1, model: modelOf(it), quality: qualityOf(it), size: ratioOf(it) === 'auto' ? undefined : sizeOf(it), format: formatOf(it) })
  }, [refineText, runGeneration])

  const enhanceText = useCallback(async (text: string, mode: 'image' | 'refine' | 'video'): Promise<string | null> => {
    if (!text.trim() || enhancing) return null
    setEnhancing(true); setError(null)
    try {
      const { data } = await apiClient.post<{ prompt?: string }>(
        '/api/studio/enhance-prompt', { prompt: text.trim(), mode }, { timeout: 90_000 },
      )
      return data.prompt ?? null
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enhance failed')
      return null
    } finally {
      setEnhancing(false)
    }
  }, [enhancing])

  const enhance = useCallback(async () => { const r = await enhanceText(prompt, genType === 'video' ? 'video' : 'image'); if (r) setPrompt(r) }, [enhanceText, prompt, genType])
  const enhanceRefine = useCallback(async () => { const r = await enhanceText(refineText, 'refine'); if (r) setRefineText(r) }, [enhanceText, refineText])

  const scrollToEntry = useCallback((id: string) => {
    setActiveId(id)
    entryRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  const reEditVideo = useCallback(async (it: StudioItem) => {
    setGenType('video')
    setVidMode((it.params?.mode as VidMode) ?? 't2v')
    setVidRatio(String(it.params?.ratio ?? '16:9'))
    setResolution(String(it.params?.resolution ?? '720p'))
    setPrompt(it.prompt)
    setRefs((it.refImages ?? []).map((url) => ({ id: nanoid(), url })))
    promptRef.current?.focus()
    // The slider is what the user then presses Generate on, so a `?? 5` here is a paid
    // 5 s clip wearing this clip's prompt. Load the MEASURED length; when the clip will
    // not probe, leave the slider where it is and say so — an untouched control is the
    // user's own number, which is the one thing here that is not a guess.
    const secs = await paidClipSeconds(it)
    if (secs === null) {
      setError('This clip will not probe, so its length could not be recovered — the duration slider is unchanged. Set it before you generate.')
      return
    }
    setDuration(Math.max(4, Math.min(15, Math.round(secs))))
  }, [paidClipSeconds])

  const regenerateVideo = useCallback(async (it: StudioItem) => {
    // Regenerate re-renders the same prompt at the same length — and the length has to be
    // this clip's, measured. `?? 5` here paid for 5 s of footage whenever the item never
    // recorded one (every clip persisted before params carried a duration).
    const secs = await paidClipSeconds(it)
    if (secs === null) {
      setError('This clip will not probe, so a regenerate would have to guess how long to make it — and the guess is footage you pay for. Set a duration and generate it from the composer instead.')
      return
    }
    void runVideoGeneration({
      prompt: it.prompt, mode: (it.params?.mode as VidMode) ?? 't2v', images: it.refImages ?? [],
      ratio: String(it.params?.ratio ?? '16:9'), resolution: String(it.params?.resolution ?? '720p'),
      // Inherit what the source clip actually had, not a hardcoded true: regenerating a
      // clip that came back mute must not walk straight back into the audio filter.
      // Items persisted before params carried the field read as false, the new default.
      duration: Math.max(4, Math.min(15, Math.round(secs))), genAudio: Boolean(it.params?.genAudio),
      tier: (it.params?.tier as VidTier) ?? 'base',
    })
  }, [paidClipSeconds, runVideoGeneration])

  const canGenerate = !!prompt.trim()
  const canEnhance = !!prompt.trim() && !enhancing
  const dlPrefix = (projectPath && projectName ? projectName : 'studio').replace(/\s+/g, '_')
  const atItems = atMenu
    ? [
        // The token FORM is per model: `<Image_1>` on 2.0, `@Image 1` on 2.5, where `<>`
        // means a sound effect instead. Same helper Stage 5 addresses references with.
        ...refs.map((r, i) => ({ key: r.id, token: refToken(vidTier, i + 1, 'Image'), label: `Image ${i + 1}`, url: r.url, kind: 'image' as const })),
        ...vidRefs.map((r, i) => ({ key: r.id, token: refToken(vidTier, i + 1, 'Video'), label: `Video ${i + 1} · ${r.name}`, url: undefined, kind: 'video' as const })),
        ...audRefs.map((r, i) => ({ key: r.id, token: refToken(vidTier, i + 1, 'Audio'), label: `Audio ${i + 1} · ${r.name}`, url: undefined, kind: 'audio' as const })),
      ].filter((it) => { const q = atMenu.query.toLowerCase(); return !q || it.token.toLowerCase().includes(q) || it.label.toLowerCase().includes(q) })
    : []
  const refLabel = (i: number): string | null => {
    if (genType === 'image') return null
    if (vidMode === 'i2v') return 'First frame'
    if (vidMode === 'first_last') return i === 0 ? 'First frame' : 'Last frame'
    if (vidMode === 'multimodal') return refToken(vidTier, i + 1, 'Image')
    return null
  }

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      {/* ── Main column ──────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2 bg-surface border-b border-border shrink-0">
          <Sparkles size={14} className="text-amber" />
          <span className="text-sm font-bold text-text-primary">Studio</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber/10 text-amber font-semibold">Free Gen</span>
          <span className="text-[11px] text-text-muted hidden md:block ml-1">standalone · Seedream / Seedance</span>
        </div>

        {/* Feed */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4">
          {items.length === 0 && pendingGens.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center select-none">
              <h2 className="text-2xl font-bold text-text-primary/90">Light Up Your Creation</h2>
              <p className="text-[12px] text-text-muted mt-2">Describe a scene below — images with {IMAGE_MODEL}, video with {VIDEO_MODEL}.</p>
            </div>
          ) : (
            <div className="max-w-2xl mx-auto w-full py-4 flex flex-col gap-5">
              {feed.map((it) => (
                <div
                  key={it.id}
                  ref={(el) => { entryRefs.current[it.id] = el }}
                  className={cn('rounded-xl border p-3 transition-colors', activeId === it.id ? 'border-cyan/50 bg-cyan/[0.03]' : 'border-transparent')}
                >
                  <p className="text-[10px] font-mono text-text-dim mb-1">{fmtDate(it.createdAt)}</p>
                  <PromptBlock id={it.id} prompt={it.prompt} />
                  <div className="flex items-center gap-x-3 gap-y-1 text-[10px] text-text-muted flex-wrap mb-2.5">
                    <span className="flex items-center gap-1"><Sparkles size={10} className="text-amber" />{it.model}</span>
                    {it.refImages?.length ? <span>Reference images·{it.refImages.length}</span> : null}
                    {it.kind === 'audio' ? (
                      <>
                        {it.params?.speaker ? <span className="font-mono">{String(it.params.speaker)}</span> : null}
                        {/* Billed on original_duration at $0.15/min — the real figure, not an estimate. */}
                        {Number(it.params?.costUsd) > 0 && (
                          <span className="font-mono text-text-dim">
                            {Number(it.params?.seconds).toFixed(1)}s · ${Number(it.params?.costUsd).toFixed(3)}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <span>Proportion {ratioOf(it)}</span>
                        {/* An upscale's price is exact — output minutes × the published coefficient —
                            so it is shown the way the audio bill is, not as an estimate. */}
                        {isUpscaled(it) && Number(it.params?.costUsd) > 0 && (
                          <span className="font-mono text-text-dim" data-testid={`studio-upscale-cost-${it.id}`}>
                            {Number(it.params?.seconds).toFixed(1)}s · ${Number(it.params?.costUsd).toFixed(3)}
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {/* Video entry */}
                  {it.kind === 'video' && it.videoUrl ? (
                    <div className="max-w-md">
                      <div className="rounded-lg overflow-hidden border border-border bg-black">
                        <video src={it.videoUrl} poster={it.posterUrl ?? undefined} controls className="w-full h-auto max-h-[60vh]" />
                      </div>
                      {/* Two rows, two families. Utility — get / redo / reopen / delete — is icon-only
                          where the glyph is self-evident (Download, Regenerate, Delete) and keeps its
                          word where it is not: "Re-edit" reopens the composer, which no icon says on
                          its own. Transform — Extend / Edit / Upscale — is ONE segmented control: each
                          sends the clip to a paid render and makes a new card, so they read as one
                          question (what to do with this clip) rather than three loose buttons. Seven
                          labelled buttons in this 448 px row used to wrap "Re-edit" onto two lines. */}
                      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                        <button onClick={() => it.videoUrl && void downloadMedia(it.videoUrl, `${dlPrefix}_video_${it.id}.mp4`)} className={cn(UTIL_BTN, 'hover:text-cyan hover:border-cyan/40')} title="Download" aria-label="Download"><Download size={13} /></button>
                        {!isUpscaled(it) && (<button onClick={() => void regenerateVideo(it)} className={UTIL_BTN} title="Regenerate this video" aria-label="Regenerate this video"><RefreshCw size={13} /></button>)}
                        {!isUpscaled(it) && (<button onClick={() => void reEditVideo(it)} className={cn(UTIL_BTN, 'gap-1 px-2')} title="Re-edit — load into the video composer"><Pencil size={12} />Re-edit</button>)}
                        <button onClick={() => { removeItem(it.id); if (activeId === it.id) setActiveId(null) }} className={cn(UTIL_BTN, 'ml-auto hover:text-red hover:border-red/40')} title="Delete generation" aria-label="Delete generation" data-testid={`studio-entry-del-${it.id}`}><Trash2 size={13} /></button>
                      </div>
                      <div className="inline-flex mt-1.5 rounded-lg border border-cyan/40 bg-cyan/5 overflow-hidden divide-x divide-cyan/30" data-testid={`studio-transform-${it.id}`}>
                        {/* C: continue this clip past Seedance's 15s cap, from its own
                            trusted last frame. The toggle joins it onto the source. */}
                        {!isUpscaled(it) && (<button onClick={() => setVidActionFor({ item: it, kind: 'extend' })} data-testid={`studio-extend-${it.id}`} className={SEG_BTN} title="Extend — continue this clip from its last frame"><Plus size={12} />Extend</button>)}
                        {!isUpscaled(it) && (<button onClick={() => setVidActionFor({ item: it, kind: 'edit' })} data-testid={`studio-vedit-${it.id}`} className={SEG_BTN} title="Edit — transform this clip with Seedance (keeps subject, framing and motion)"><Wand2 size={12} />Edit</button>)}
                        {/* AI MediaKit: re-render at 2K/4K/8K. Works on an upscaled card too (other settings). */}
                        <button onClick={() => { setVidActionFor({ item: it, kind: 'upscale' }); setUpQuote(null) }} data-testid={`studio-upscale-${it.id}`} className={SEG_BTN} title="Upscale — AI MediaKit re-renders this clip at 2K, 4K or 8K"><Maximize2 size={12} />Upscale</button>
                      </div>
                      {/* A Seedance property: MediaKit masters are 8-bit H.264 whatever their size. */}
                      {!isUpscaled(it) && isTenBit(String(it.params?.tier ?? 'base'), String(it.params?.resolution)) && <p className="text-[10px] text-amber/80 mt-1.5">{String(it.params?.resolution) === '4k' ? '4K' : '1080p on 2.5'} is 10-bit — if it won’t play in the browser, download to view.</p>}
                    </div>
                  ) : it.kind === 'audio' && it.audioUrl ? (
                    <div className="max-w-md">
                      <audio src={it.audioUrl} controls className="w-full" />
                      <div className="flex items-center gap-1 mt-1.5">
                        <button onClick={() => it.audioUrl && void downloadMedia(it.audioUrl, `${dlPrefix}_voice_${it.id}.mp3`)} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-cyan hover:border-cyan/40" title="Download"><Download size={12} />Download</button>
                        <button onClick={() => { removeItem(it.id); if (activeId === it.id) setActiveId(null) }} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-red hover:border-red/40 ml-auto" title="Delete" data-testid={`studio-entry-del-${it.id}`}><Trash2 size={12} /></button>
                      </div>
                    </div>
                  ) : (
                  /* Images — each one has its own Refine / Regenerate / Re-edit / Delete */
                  <div className={cn('grid gap-3', it.imageUrls.length > 1 ? 'grid-cols-2' : 'grid-cols-1 max-w-md')}>
                    {it.imageUrls.map((u, i) => {
                      const key = `${it.id}:${i}`
                      return (
                        <div key={i}>
                          <div className="relative group rounded-lg overflow-hidden border border-border bg-elevated">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={u} alt={it.prompt} onClick={() => setZoomUrl(u)}
                              data-testid={`studio-zoom-${it.id}-${i}`}
                              title="Click to view full size"
                              className="w-full h-auto object-contain max-h-[60vh] cursor-zoom-in" />
                            <button onClick={() => void downloadMedia(u, `${dlPrefix}_image_${it.id}_${i + 1}.png`)} className="absolute top-2 right-2 p-1.5 rounded bg-bg/70 text-text-muted opacity-0 group-hover:opacity-100 hover:text-cyan transition-opacity" title="Download"><Download size={13} /></button>
                          </div>
                          {/* Per-image actions */}
                          <div className="flex items-center gap-1 mt-1.5">
                            <button onClick={() => { setRefineFor(key); setRefineText('') }} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-cyan hover:border-cyan/40" title="Refine — keep this image, add or change something"><Wand2 size={12} />Refine</button>
                            <button onClick={() => regenerateImage(it)} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary hover:border-text-dim" title="Regenerate one image (same prompt + settings)"><RefreshCw size={12} /></button>
                            <button onClick={() => reEditImage(it)} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary hover:border-text-dim" title="Re-edit — load the prompt + references into the composer"><Pencil size={12} /></button>
                            {/* Hand the editor the DISK path when we have one: its canvas
                                loads through /api/image/proxy, which only accepts a path or
                                a BytePlus CDN host — a served localhost url is rejected
                                ("host not allowed") and the canvas stays black (2026-07-27). */}
                            <button onClick={() => setProEditFor({ item: it, url: diskPathOf(u) || u })} data-testid={`studio-pro-edit-${it.id}-${i}`} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-cyan/40 bg-cyan/5 text-[11px] text-cyan hover:bg-cyan/15" title="Edit with Seedream 5.0 Pro — markup, references and an instruction (same editor as the pipeline)"><Wand2 size={12} />Edit</button>
                            {/* Straight to Seedance i2v — no need to switch mode and
                                re-attach the image in the composer. */}
                            <button onClick={() => setAnimateFor({ item: it, url: diskPathOf(u) || u })} data-testid={`studio-animate-${it.id}-${i}`} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-cyan/40 bg-cyan/5 text-[11px] text-cyan hover:bg-cyan/15" title="Animate with Seedance — turn this still into a clip"><Film size={12} />Animate</button>
                            <button onClick={() => { removeImage(it.id, i); if (activeId === it.id && it.imageUrls.length === 1) setActiveId(null) }} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-red hover:border-red/40 ml-auto" title="Delete this image" data-testid={`studio-preview-del-${it.id}-${i}`}><Trash2 size={12} /></button>
                          </div>
                          {/* Refine instruction */}
                          {refineFor === key && (
                            <div className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-cyan/40 bg-elevated p-1.5">
                              <Wand2 size={13} className="text-cyan shrink-0 ml-1 mt-1.5" />
                              <textarea
                                autoFocus
                                ref={refineTaRef}
                                rows={1}
                                value={refineText}
                                onChange={(e) => { setRefineText(e.target.value); autoGrow(e.currentTarget) }}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doRefine(it, u) } else if (e.key === 'Escape') setRefineFor(null) }}
                                placeholder="What to add or change (e.g. add wings to the horse)"
                                className="flex-1 bg-transparent text-[12px] text-text-primary placeholder:text-text-dim outline-none resize-none overflow-y-auto max-h-28 leading-snug py-1"
                              />
                              <button onClick={() => void enhanceRefine()} disabled={!refineText.trim() || enhancing} title="Enhance this edit instruction with Claude" className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold border border-amber/50 text-amber bg-amber/5 hover:bg-amber/15 disabled:opacity-50">{enhancing ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}Enhance</button>
                              <button onClick={() => doRefine(it, u)} disabled={!refineText.trim()} className="px-2.5 py-1 rounded bg-cyan text-bg text-[11px] font-semibold disabled:opacity-50">Refine</button>
                              <button onClick={() => setRefineFor(null)} className="px-1 text-text-muted hover:text-text-primary" title="Cancel"><X size={13} /></button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  )}
                </div>
              ))}

              {/* In-flight generations (run concurrently — fire as many as you like) */}
              {pendingUpscales.map((p) => (
                <div key={p.id} className="rounded-xl border border-cyan/30 bg-cyan/[0.03] p-3" data-testid={`studio-upscale-pending-${p.id}`}>
                  <p className="text-sm text-text-primary mb-1.5">{p.prompt}</p>
                  <div className="flex items-center gap-x-3 text-[10px] text-text-muted flex-wrap mb-2.5">
                    <span className="flex items-center gap-1"><Sparkles size={10} className="text-amber" />{p.model}</span>
                    <span>Proportion {p.ratio}</span>
                  </div>
                  <div className="flex flex-col items-center gap-1 text-sm text-text-muted py-5">
                    <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin text-cyan" /> Upscaling with AI MediaKit… <Elapsed since={p.startedAt} /></span>
                    <span className="text-[10px] text-text-dim">Runs on the server — you can leave this page; the clip appears here when it is done.</span>
                  </div>
                </div>
              ))}
              {pendingGens.map((pg) => (
                <div key={pg.id} className="rounded-xl border border-cyan/30 bg-cyan/[0.03] p-3" data-testid={`studio-pending-${pg.kind}`}>
                  <p className="text-sm text-text-primary mb-1.5">{pg.prompt}</p>
                  <div className="flex items-center gap-x-3 text-[10px] text-text-muted flex-wrap mb-2.5">
                    <span className="flex items-center gap-1"><Sparkles size={10} className="text-amber" />{pg.model}</span>
                    {pg.refCount > 0 && <span>Reference{pg.kind === 'video' ? 's' : ' images'}·{pg.refCount}</span>}
                    {pg.kind !== 'audio' && <span>Proportion {pg.ratio}</span>}
                    {pg.kind === 'image' && <span>{pg.count} img</span>}
                  </div>
                  <div className="flex flex-col items-center gap-1 text-sm text-text-muted py-5">
                    <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin text-cyan" /> Generating with {pg.model}…</span>
                    {pg.kind === 'video' && <span className="text-[10px] text-text-dim">Video can take a few minutes — keep this tab open.</span>}
                  </div>
                </div>
              ))}
              <div ref={feedEndRef} />
            </div>
          )}
        </div>

        {/* Prompt bar */}
        <div className="shrink-0 border-t border-border bg-surface p-3">
          {error && <p className="text-[11px] text-red mb-2">{error}</p>}
          <div className="rounded-xl border border-border bg-elevated p-2.5 flex flex-col gap-2">
            {/* First+Last: two explicit slots */}
            {genType === 'video' && vidMode === 'first_last' ? (
              <div className="flex items-end gap-3">
                {[0, 1].map((idx) => {
                  const slot = refs[idx]
                  const label = idx === 0 ? 'First frame' : 'Last frame'
                  const disabled = idx === 1 && !refs[0]?.url
                  return (
                    <div key={idx} className="flex flex-col items-center gap-1">
                      {slot?.url ? (
                        <div className="relative w-14 h-14 rounded border border-border overflow-hidden group">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={slot.url} alt={label} className="w-full h-full object-cover" />
                          <button onClick={() => clearSlot(idx)} className="absolute top-0 right-0 p-0.5 bg-bg/70 text-text-muted opacity-0 group-hover:opacity-100 hover:text-red" title="Remove"><X size={10} /></button>
                        </div>
                      ) : (
                        <button onClick={() => !disabled && openSlot(idx)} disabled={disabled} title={disabled ? 'Add the first frame first' : `Attach ${label.toLowerCase()}`}
                          className={cn('w-14 h-14 rounded border border-dashed flex items-center justify-center', disabled ? 'border-border/40 text-text-dim cursor-not-allowed' : 'border-border text-text-muted hover:text-cyan hover:border-cyan/40')}><Plus size={16} /></button>
                      )}
                      <span className="text-[9px] text-text-dim">{label}</span>
                    </div>
                  )
                })}
                <input ref={slotFileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void onSlotFile(e.target.files); e.target.value = '' }} />
              </div>
            ) : maxRefs > 0 && refs.length > 0 ? (
              <div className="flex items-end gap-2 flex-wrap">
                {refs.slice(0, maxRefs).map((r, i) => {
                  const label = refLabel(i)
                  const isToken = genType === 'video' && vidMode === 'multimodal'
                  return (
                    <div key={r.id} data-testid="studio-ref-thumb" className="flex flex-col items-center gap-1">
                      <div className="relative w-12 h-12 rounded border border-border overflow-hidden group">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={r.url} alt="ref" className="w-full h-full object-cover" />
                        <button onClick={() => setRefs((p) => p.filter((x) => x.id !== r.id))} className="absolute top-0 right-0 p-0.5 bg-bg/70 text-text-muted opacity-0 group-hover:opacity-100 hover:text-red" title="Remove reference"><X size={10} /></button>
                      </div>
                      {label && (
                        isToken
                          ? <button onClick={() => insertToken(label)} className="text-[9px] font-mono text-cyan hover:underline" title="Insert this tag into the prompt">{label}</button>
                          : <span className="text-[9px] text-text-dim">{label}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : null}

            {/* Multimodal: video + audio references, tagged in the addressing form the
                selected model uses (<Video_N> on 2.0, @Video N on 2.5). */}
            {genType === 'video' && vidMode === 'multimodal' && (
              <div className="flex items-center gap-2 flex-wrap">
                {vidRefs.map((r, i) => (
                  <span key={r.id} className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg border border-border text-[10px]">
                    <Film size={11} className="text-cyan shrink-0" />
                    <button onClick={() => insertToken(refToken(vidTier, i + 1, 'Video'))} className="font-mono text-cyan hover:underline" title="Insert tag into the prompt">{refToken(vidTier, i + 1, 'Video')}</button>
                    <span className="text-text-dim max-w-[80px] truncate">{r.name}</span>
                    <button onClick={() => setVidRefs((p) => p.filter((x) => x.id !== r.id))} className="text-text-muted hover:text-red"><X size={11} /></button>
                  </span>
                ))}
                {/* Budget is per-model, not fixed: 3 videos / 15 s total on the 2.0 family,
                    10 videos / 30 s total on 2.5. Hardcoding 3 made 2.5's larger reference
                    budget unreachable from the UI no matter what the backend accepted. */}
                {vidRefs.length < tierOf(vidTier).refs.videos && (
                  <button onClick={() => vidFileRef.current?.click()} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-dashed border-border text-[10px] text-text-muted hover:text-cyan hover:border-cyan/40" title={`Add a reference video (motion) — up to ${tierOf(vidTier).refs.videos}, ≤${tierMaxSecs(vidTier)}s total`}><Plus size={11} /><Film size={11} />Video</button>
                )}
                {audRefs.map((r, i) => (
                  <span key={r.id} className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg border border-border text-[10px]">
                    <Music size={11} className="text-amber shrink-0" />
                    <button onClick={() => insertToken(refToken(vidTier, i + 1, 'Audio'))} className="font-mono text-amber hover:underline" title="Insert tag into the prompt">{refToken(vidTier, i + 1, 'Audio')}</button>
                    <span className="text-text-dim max-w-[80px] truncate">{r.name}</span>
                    <button onClick={() => setAudRefs((p) => p.filter((x) => x.id !== r.id))} className="text-text-muted hover:text-red"><X size={11} /></button>
                  </span>
                ))}
                {audRefs.length < tierOf(vidTier).refs.audios && (
                  <button onClick={() => audFileRef.current?.click()} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-dashed border-border text-[10px] text-text-muted hover:text-amber hover:border-amber/40" title={`Add a reference audio (wav/mp3, ≤${tierMaxSecs(vidTier)}s total, ≤15MB) — up to ${tierOf(vidTier).refs.audios}${vidTier === 'v25' ? '' : '; needs ≥1 image/video'}`}><Plus size={11} /><Music size={11} />Audio</button>
                )}
                <input ref={vidFileRef} type="file" accept="video/*" className="hidden" onChange={(e) => { void addMediaRefs(e.target.files, 'video'); e.target.value = '' }} />
                <input ref={audFileRef} type="file" accept="audio/*" className="hidden" onChange={(e) => { void addMediaRefs(e.target.files, 'audio'); e.target.value = '' }} />
              </div>
            )}

            {/* Prompt */}
            <div className="relative flex items-start gap-2">
              {/* @-mention picker */}
              {atMenu && atItems.length > 0 && (
                <div className="absolute bottom-full left-8 mb-1 z-40 w-52 max-h-56 overflow-y-auto rounded-lg border border-border bg-elevated shadow-xl p-1">
                  <p className="text-[9px] text-text-dim uppercase tracking-widest px-2 py-1">Reference</p>
                  {atItems.map((it) => (
                    <button key={it.key} onClick={() => pickToken(it.token)} className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg text-left">
                      {it.kind === 'image' && it.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={it.url} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
                      ) : (
                        <span className="w-6 h-6 rounded bg-bg flex items-center justify-center text-text-muted shrink-0">{it.kind === 'video' ? <Film size={12} /> : <Music size={12} />}</span>
                      )}
                      <span className="text-[11px] text-text-primary font-mono truncate">{it.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {maxRefs > 0 && vidMode !== 'first_last' && refs.length < maxRefs && (
                <button onClick={() => fileRef.current?.click()} className="shrink-0 w-9 h-9 rounded border border-dashed border-border flex items-center justify-center text-text-muted hover:text-cyan hover:border-cyan/40" title={genType === 'video' ? 'Add reference image' : 'Add reference image (image-to-image)'}><Plus size={14} /></button>
              )}
              <textarea
                ref={promptRef}
                value={prompt}
                onChange={onPromptChange}
                onKeyDown={(e) => { if (e.key === 'Escape') setAtMenu(null); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); generate() } }}
                placeholder={genType === 'voice'
                  ? (voiceEngine === 'seedaudio' && audioMode === 'scene'
                      ? 'Describe the whole scene — where it is, the music, the sound effects, then who says what. e.g. "A rain-soaked street at night, distant traffic. Music: slow melancholy piano. A woman (late 30s, warm low voice) says softly: \'You came back.\'"'
                      : 'Type the text to speak…') : genType === 'image' ? 'Describe the scene you want to generate' : vidMode === 'multimodal' ? 'Describe the motion · type @ to reference an image' : 'Describe the motion'}
                className="flex-1 bg-transparent resize-none text-sm text-text-primary placeholder:text-text-dim outline-none px-1 pt-1.5 min-h-[3.5rem] max-h-48 overflow-y-auto"
              />
              <input ref={fileRef} data-testid="studio-ref-input" type="file" accept="image/*" multiple className="hidden" onChange={(e) => { void addRefs(e.target.files); e.target.value = '' }} />
            </div>

            {/* Controls row. Two columns on purpose: the settings wrap inside their own
                column while Enhance + Generate stay pinned right on the FIRST line. As one
                wrapping row they dropped to a second line as soon as video mode added
                enough controls — the actions must never move. */}
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
              {/* What to make. Four side-by-side buttons ate the width the video controls
                  need, pushing the row onto a second line — one dropdown keeps everything
                  on one line. Character is an ACTION, not a mode: it opens the creator and
                  leaves the current mode alone. */}
              <div className="relative">
                <button onClick={() => setShowModeMenu((v) => !v)} data-testid="studio-mode"
                  title="What to generate"
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-cyan/40 bg-cyan/5 text-[11px] font-semibold text-cyan hover:bg-cyan/15">
                  {(() => { const M = GEN_MODES.find((m) => m.id === genType)!; return <><M.icon size={12} />{M.label}</> })()}
                  <ChevronDown size={11} />
                </button>
                {showModeMenu && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setShowModeMenu(false)} />
                    <div className="absolute bottom-full mb-1.5 left-0 z-30 w-44 p-1.5 rounded-lg border border-border bg-elevated shadow-xl flex flex-col gap-0.5">
                      {GEN_MODES.map((m) => (
                        <button key={m.id} onClick={() => { setGenType(m.id); setShowModeMenu(false) }}
                          data-testid={`studio-mode-${m.id}`}
                          className={cn('flex items-center gap-1.5 px-2 py-1.5 rounded text-[11px] text-left',
                            genType === m.id ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-bg hover:text-text-primary')}>
                          <m.icon size={12} />{m.label}
                        </button>
                      ))}
                      <div className="h-px bg-border my-0.5" />
                      <button onClick={() => { setCharCreatorOpen(true); setShowModeMenu(false) }}
                        data-testid="open-character-creator"
                        title="AI Character Creator — build a character from fields (or a photo) and render its reference sheet"
                        className="flex items-center gap-1.5 px-2 py-1.5 rounded text-[11px] text-left text-cyan hover:bg-cyan/10">
                        <UserPlus size={12} />Character Creator…
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* (No model chip. Every mode now carries its own model selector — Pro/Lite
                  for images, the tier dropdown for video, the engine dropdown for audio —
                  and the chip printed a HARDCODED name beside them: it said "Seedance 2.0"
                  with Fast selected and "Seedream 5.0 Pro" with Lite selected. Redundant
                  when right and misleading when not.) */}

              {genType === 'image' && (
                <>
                  {/* Engine: Pro = strongest reference fidelity but ~2K max; Lite = the
                      2K/3K/4K presets, so it is the only one that truly renders 4K. */}
                  <div className="flex items-center rounded-lg border border-border overflow-hidden">
                    {([['pro', 'Pro'], ['lite', 'Lite']] as const).map(([id, label]) => (
                      <button
                        key={id}
                        onClick={() => { setImgModel(id); if (id === 'pro') setImgQuality('2K') }}
                        data-testid={`img-model-${id}`}
                        title={id === 'pro'
                          ? 'Seedream 5.0 Pro — best reference consistency; caps at ~2K'
                          : 'Seedream 5.0 Lite — supports up to 4K output'}
                        className={cn('px-2 py-1 text-[11px] transition-colors',
                          imgModel === id ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:text-text-primary')}
                      >{label}</button>
                    ))}
                  </div>

                  {/* Output size. 4K needs Lite — Pro would be clamped back to 2K anyway. */}
                  <div className="flex items-center rounded-lg border border-border overflow-hidden">
                    {(['2K', '4K'] as const).map((q) => (
                      <button
                        key={q}
                        onClick={() => { if (q === '4K') setImgModel('lite'); setImgQuality(q) }}
                        data-testid={`img-quality-${q}`}
                        title={q === '4K' ? 'Up to 4K — switches the engine to Lite (Pro caps at ~2K)' : 'Standard 2K output'}
                        className={cn('px-2 py-1 text-[11px] font-mono transition-colors',
                          imgQuality === q ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:text-text-primary')}
                      >{q}</button>
                    ))}
                  </div>

                  {/* Aspect ratio */}
                  <div className="relative">
                    <button onClick={() => setShowRatio((v) => !v)} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary" title="Aspect ratio">
                      <span className="font-mono">{ratio === 'auto' ? 'Auto' : ratio}</span><ChevronDown size={11} />
                    </button>
                    {showRatio && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowRatio(false)} />
                        <div className="absolute bottom-full mb-1.5 left-0 z-30 w-40 grid grid-cols-2 gap-1 p-1.5 rounded-lg border border-border bg-elevated shadow-xl">
                          {RATIO_KEYS.map((k) => (
                            <button
                              key={k}
                              onClick={() => { setRatio(k); setShowRatio(false) }}
                              className={cn('py-1.5 rounded-md text-[11px] font-mono text-center border transition-colors',
                                ratio === k ? 'bg-cyan/15 text-cyan border-cyan/40' : 'text-text-muted border-border hover:bg-bg hover:text-text-primary')}
                            data-testid={`img-ratio-${k}`}
                              title={k === 'auto' ? 'Follow the reference image\'s aspect ratio (1:1 when there is none)' : undefined}
                            >{k === 'auto' ? 'Auto' : k}</button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  {/* Formato de salida — png sin pérdida, jpeg más ligero. Ambos motores de
                      Studio lo aceptan (image-seedream.md §4 y el tutorial de 5.0 pro). */}
                  <div className="flex items-center rounded-lg border border-border overflow-hidden">
                    {([['png', 'PNG'], ['jpeg', 'JPG']] as const).map(([f, label]) => (
                      <button
                        key={f}
                        onClick={() => setImgFormat(f)}
                        data-testid={`img-format-${f}`}
                        title={f === 'png' ? 'PNG — lossless' : 'JPEG — smaller files'}
                        className={cn('px-2 py-1 text-[11px] font-mono transition-colors',
                          imgFormat === f ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:text-text-primary')}
                      >{label}</button>
                    ))}
                  </div>

                  {/* Count. Seedream's hard cap is on input references + generated images
                      TOGETHER (≤15), so a large reference set costs batch slots. Offering a
                      batch the refs have already spent buys a 400 at submit time. */}
                  <div className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted"
                    title={`Number of images — Seedream allows references + generated ≤ ${SEEDREAM_MAX_REFS_PLUS_IMAGES} (${refs.length} reference${refs.length === 1 ? '' : 's'} attached)`}>
                    <Settings2 size={11} />
                    <select value={effectiveCount} onChange={(e) => setCount(Number(e.target.value))} className="bg-transparent outline-none cursor-pointer">
                      {[1, 2, 3, 4].filter((n) => n <= imgCountCeiling).map((n) => <option key={n} value={n} className="bg-elevated">{n} img</option>)}
                    </select>
                  </div>
                </>
              )}

              {genType === 'video' && (
                <>
                  {/* Model tier. Picking a capped tier DOWNGRADES the resolution instead of
                      leaving an impossible pick selected (the backend would 400 on it). */}
                  <div className="relative">
                    <button onClick={() => setShowTierMenu((v) => !v)} data-testid="vid-tier"
                      title="Seedance model"
                      className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary">
                      {VIDEO_TIERS.find((t) => t.id === vidTier)!.label}
                      <ChevronDown size={11} />
                    </button>
                    {showTierMenu && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowTierMenu(false)} />
                        <div className="absolute bottom-full mb-1.5 left-0 z-30 w-56 p-1.5 rounded-lg border border-border bg-elevated shadow-xl flex flex-col gap-0.5">
                          {VIDEO_TIERS.map((t) => (
                            <button key={t.id}
                              onClick={() => {
                                setVidTier(t.id); setShowTierMenu(false)
                                const allowed = resolutionsFor(t.id)
                                if (!allowed.includes(resolution as typeof VIDEO_RESOLUTIONS[number])) {
                                  setResolution(t.max)
                                  setError(`${t.label} tops out at ${t.max} — resolution set to ${t.max}.`)
                                }
                                // Same downgrade for clip length: stepping off 2.5 (30 s) onto a
                                // 2.0 tier (15 s) would otherwise leave an out-of-range duration
                                // that the vendor rejects as an opaque 400.
                                if (duration > t.maxSecs) {
                                  setDuration(t.maxSecs)
                                  setError(`${t.label} tops out at ${t.maxSecs}s — duration set to ${t.maxSecs}s.`)
                                }
                              }}
                              data-testid={`vid-tier-${t.id}`}
                              className={cn('flex flex-col items-start px-2 py-1.5 rounded text-left',
                                vidTier === t.id ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-bg hover:text-text-primary')}>
                              <span className="text-[11px] font-semibold">{t.label}</span>
                              <span className="text-[9px] opacity-70">{t.hint}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Sub-mode dropdown */}
                  <div className="relative">
                    <button onClick={() => setShowVidMenu((v) => (v === 'mode' ? null : 'mode'))} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] font-semibold text-cyan hover:border-cyan/40" title="Generation type">
                      {VIDEO_MODES.find((m) => m.id === vidMode)?.label}<ChevronDown size={11} />
                    </button>
                    {showVidMenu === 'mode' && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowVidMenu(null)} />
                        <div className="absolute bottom-full mb-1.5 left-0 z-30 w-44 flex flex-col gap-0.5 p-1 rounded-lg border border-border bg-elevated shadow-xl">
                          {VIDEO_MODES.map((m) => (
                            <button key={m.id} onClick={() => changeVidMode(m.id)} className={cn('flex items-center justify-between px-2 py-1.5 rounded text-[11px] text-left', vidMode === m.id ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-bg hover:text-text-primary')}>
                              <span className="font-semibold">{m.label}</span>
                              {/* Multimodal's budget follows the selected tier (9 on 2.0, 30 on 2.5),
                                  so read it the same way the input gate does — a static "9 refs"
                                  label would contradict what the picker actually allows. */}
                              {vidModeRefs(m.id, vidTier) > 0 && (
                                <span className="text-[9px] text-text-dim">
                                  {vidModeRefs(m.id, vidTier)} ref{vidModeRefs(m.id, vidTier) > 1 ? 's' : ''}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Resolution */}
                  <div className="relative">
                    <button onClick={() => setShowVidMenu((v) => (v === 'res' ? null : 'res'))} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary" title="Resolution"><span className="font-mono">{resolution}</span><ChevronDown size={11} /></button>
                    {showVidMenu === 'res' && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowVidMenu(null)} />
                        <div className="absolute bottom-full mb-1.5 left-0 z-30 w-28 flex flex-col gap-0.5 p-1 rounded-lg border border-border bg-elevated shadow-xl">
                          {resolutionsFor(vidTier).map((r) => (
                            <button key={r} onClick={() => { setResolution(r); setShowVidMenu(null) }} className={cn('px-2 py-1 rounded text-[11px] font-mono text-left', resolution === r ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-bg')}>{r}{isTenBit(vidTier, r) ? ' · 10-bit' : ''}</button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Aspect ratio */}
                  <div className="relative">
                    <button onClick={() => setShowVidMenu((v) => (v === 'ratio' ? null : 'ratio'))} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary" title="Aspect ratio"><span className="font-mono">{VIDEO_RATIOS.find((r) => r.value === vidRatio)?.label ?? vidRatio}</span><ChevronDown size={11} /></button>
                    {showVidMenu === 'ratio' && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowVidMenu(null)} />
                        <div className="absolute bottom-full mb-1.5 left-0 z-30 w-28 grid grid-cols-2 gap-1 p-1.5 rounded-lg border border-border bg-elevated shadow-xl">
                          {VIDEO_RATIOS.map((r) => (
                            <button key={r.value} onClick={() => { setVidRatio(r.value); setShowVidMenu(null) }} className={cn('py-1 rounded text-[10px] font-mono text-center border', vidRatio === r.value ? 'bg-cyan/15 text-cyan border-cyan/40' : 'text-text-muted border-border hover:bg-bg')}>{r.label}</button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Duration */}
                  <div className="relative">
                    <button onClick={() => setShowVidMenu((v) => (v === 'duration' ? null : 'duration'))} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary" title="Duration (seconds)">
                      <span className="font-mono">{duration === -1 ? 'AUTO' : `${duration}s`}</span><ChevronDown size={11} />
                    </button>
                    {showVidMenu === 'duration' && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowVidMenu(null)} />
                        <div className="absolute bottom-full mb-1.5 left-0 z-30 w-28 flex flex-col gap-0.5 p-1 rounded-lg border border-border bg-elevated shadow-xl max-h-52 overflow-auto">
                          <button onClick={() => { setDuration(-1); setShowVidMenu(null) }} className={cn('px-2 py-1 rounded text-[11px] text-left', duration === -1 ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-bg')}>AUTO</button>
                          {Array.from({ length: tierMaxSecs(vidTier) - 3 }, (_, i) => i + 4).map((s) => (
                            <button key={s} onClick={() => { setDuration(s); setShowVidMenu(null) }} className={cn('px-2 py-1 rounded text-[11px] font-mono text-left', duration === s ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-bg')}>{s}s</button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted" title="Duration slider">
                    <span className="font-mono text-text-dim w-6">{duration === -1 ? 'Auto' : `${duration}s`}</span>
                    {/* Ceiling is per-model: 15 s on the 2.0 family, 30 s on 2.5. */}
                    <input type="range" min={4} max={tierMaxSecs(vidTier)} value={duration === -1 ? 4 : duration} onChange={(e) => setDuration(Number(e.target.value))} className="w-16 accent-cyan" disabled={duration === -1} />
                    <button onClick={() => setDuration(-1)} className={cn('px-1.5 py-0.5 rounded border text-[10px]', duration === -1 ? 'bg-cyan/15 text-cyan border-cyan/40' : 'border-border text-text-dim hover:text-text-primary')} title="Automatic (reference video duration)">Auto</button>
                  </div>

                  {/* Audio */}
                  <button onClick={() => setGenAudio((v) => !v)} title="Generate audio (mono)"
                    className={cn('flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px]', genAudio ? 'border-cyan/40 text-cyan bg-cyan/5' : 'border-border text-text-muted')}>{genAudio ? <Volume2 size={12} /> : <VolumeX size={12} />}Audio</button>
                </>
              )}

              {genType === 'voice' && (
                <>
                  {/* Engine. A dropdown rather than two buttons — the audio row already
                      carries mode, model, subtitles and the voice slots. Switching to
                      TTS 2.0 drops the reference: that engine has no reference channel. */}
                  <div className="relative">
                    <button onClick={() => setShowEngineMenu((v) => !v)} data-testid="voice-engine"
                      title="Audio engine"
                      className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary">
                      {AUDIO_ENGINES.find((e) => e.id === voiceEngine)!.label}
                      <ChevronDown size={11} />
                    </button>
                    {showEngineMenu && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowEngineMenu(false)} />
                        <div className="absolute bottom-full mb-1.5 left-0 z-30 w-56 p-1.5 rounded-lg border border-border bg-elevated shadow-xl flex flex-col gap-0.5">
                          {AUDIO_ENGINES.map((e) => (
                            <button key={e.id}
                              onClick={() => { setVoiceEngine(e.id); if (e.id === 'tts2') setVoiceRef(null); setShowEngineMenu(false) }}
                              data-testid={`voice-engine-${e.id}`}
                              className={cn('flex flex-col items-start px-2 py-1.5 rounded text-left',
                                voiceEngine === e.id ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-bg hover:text-text-primary')}>
                              <span className="text-[11px] font-semibold">{e.label}</span>
                              <span className="text-[9px] opacity-70">{e.hint}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Voice vs Scene. Scene is what turns Seed Audio from a TTS into a
                      soundtrack engine: one prompt renders ambience, score, SFX and the
                      dialogue together. */}
                  {voiceEngine === 'seedaudio' && (
                    <div className="flex items-center rounded-lg border border-border overflow-hidden">
                      {([['voice', 'Voice'], ['scene', 'Scene']] as const).map(([id, label]) => (
                        <button key={id} onClick={() => setAudioMode(id)} data-testid={`audio-mode-${id}`}
                          title={id === 'voice'
                            ? 'One line, one voice'
                            : 'Describe a whole scene — environment, music, sound effects and dialogue — rendered as one track'}
                          className={cn('px-2 py-1 text-[11px] transition-colors',
                            audioMode === id ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:text-text-primary')}
                        >{label}</button>
                      ))}
                    </div>
                  )}

                  {voiceEngine === 'seedaudio' && (
                    <>
                      <button onClick={() => setAudioMultilingual((v) => !v)} data-testid="audio-multilingual"
                        title={audioMultilingual
                          ? '20 languages + [5.5s:8.0s] timing control'
                          : 'English / Chinese only, no timing control'}
                        className={cn('flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px]',
                          audioMultilingual ? 'border-cyan/40 bg-cyan/5 text-cyan' : 'border-border text-text-muted')}
                      >{audioMultilingual ? 'Multilingual' : 'EN/ZH'}</button>
                      <button onClick={() => setAudioSubtitles((v) => !v)} data-testid="audio-subtitles"
                        title="Return word- and sentence-level timestamps with the audio"
                        className={cn('flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px]',
                          audioSubtitles ? 'border-cyan/40 bg-cyan/5 text-cyan' : 'border-border text-text-muted')}
                      >Subtitles</button>
                    </>
                  )}

                  {/* Reference (Seed Audio only): ONE clip OR one portrait — never both. */}
                  {voiceEngine === 'seedaudio' && audioMode === 'voice' && (
                    <>
                      <input ref={voiceRefFileRef} type="file" accept="audio/*,image/*" className="hidden"
                        onChange={(e) => { void addVoiceRef(e.target.files); e.target.value = '' }} />
                      {voiceRef ? (
                        <button
                          onClick={() => setVoiceRef(null)}
                          data-testid="voice-ref-clear"
                          title={`${voiceRef.kind === 'audio' ? 'Cloning this voice' : 'Designing a voice from this portrait'} — click to remove`}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg border border-cyan/40 bg-cyan/5 text-[11px] text-cyan"
                        >
                          {voiceRef.kind === 'audio' ? <Music size={11} /> : <ImageIcon size={11} />}
                          <span className="truncate max-w-[110px]">{voiceRef.name}</span>
                          <X size={11} />
                        </button>
                      ) : (
                        <button
                          onClick={() => voiceRefFileRef.current?.click()}
                          data-testid="voice-ref-add"
                          title="Reference: a voice clip to clone (≤30s, ≤10MB) or a portrait to design a voice from (≤10MB)"
                          className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary"
                        ><Plus size={11} />Voice ref</button>
                      )}
                    </>
                  )}

                  {/* Scene mode: up to THREE clips, cited as @Audio1..@Audio3 in the
                      prompt (upload order IS the numbering), so each character keeps
                      a distinct voice across the scene. */}
                  {voiceEngine === 'seedaudio' && audioMode === 'scene' && (
                    <>
                      <input ref={voiceRefFileRef} type="file" accept="audio/*" multiple className="hidden"
                        onChange={(e) => { void addSceneRefs(e.target.files); e.target.value = '' }} />
                      {sceneRefs.map((r, i) => (
                        <button key={r.id} onClick={() => setSceneRefs((p) => p.filter((x) => x.id !== r.id))}
                          data-testid={`scene-ref-${i + 1}`}
                          title={`@Audio${i + 1} — ${r.name} (click to remove)`}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg border border-cyan/40 bg-cyan/5 text-[11px] text-cyan">
                          <Music size={11} />@Audio{i + 1}<X size={10} />
                        </button>
                      ))}
                      {sceneRefs.length < 3 && (
                        <button onClick={() => voiceRefFileRef.current?.click()} data-testid="scene-ref-add"
                          title="Add a voice clip (≤30s, ≤10MB) — cite it as @Audio1, @Audio2… in the prompt"
                          className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary">
                          <Plus size={11} />Voice {sceneRefs.length + 1}
                        </button>
                      )}
                    </>
                  )}

                  {/* Speaker */}
                  <div className="relative">
                    <button onClick={() => setShowVoiceMenu((v) => (v === 'speaker' ? null : 'speaker'))} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary" title="Voice">
                      <Music size={11} className="text-amber" /><span className="truncate max-w-[120px]">{VOICES.find((v) => v.id === speaker)?.name ?? speaker}</span><ChevronDown size={11} />
                    </button>
                    {showVoiceMenu === 'speaker' && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowVoiceMenu(null)} />
                        <div className="absolute bottom-full mb-1.5 left-0 z-30 w-60 p-1.5 rounded-lg border border-border bg-elevated shadow-xl flex flex-col gap-1">
                          {/* Gender filter */}
                          <div className="flex items-center gap-1 px-0.5">
                            {([['all', 'All'], ['F', '♀ Female'], ['M', '♂ Male']] as const).map(([g, lbl]) => (
                              <button key={g} onClick={() => setVoiceFilter(g)} className={cn('px-2 py-0.5 rounded text-[10px] font-semibold', voiceFilter === g ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-bg')}>{lbl}</button>
                            ))}
                          </div>
                          <div className="max-h-60 overflow-y-auto flex flex-col gap-0.5 pr-0.5">
                            {VOICES.filter((v) => voiceFilter === 'all' || v.gender === voiceFilter).map((v) => (
                              <button key={v.id} onClick={() => { setSpeaker(v.id); setShowVoiceMenu(null) }} className={cn('flex items-center justify-between gap-2 px-2 py-1.5 rounded text-[11px] text-left', speaker === v.id ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-bg hover:text-text-primary')}>
                                <span className="truncate">{v.gender === 'F' ? '♀' : '♂'} {v.name}</span>
                                <span className="text-[9px] text-text-dim font-mono shrink-0">{v.lang}</span>
                              </button>
                            ))}
                          </div>
                          <input value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="or paste a voice id…" className="mt-1 px-2 py-1 rounded bg-bg border border-border text-[10px] font-mono text-text-primary outline-none" />
                          <a href="https://docs.byteplus.com/en/docs/byteplusvoice/voicelist" target="_blank" rel="noopener" className="text-[9px] text-text-dim hover:text-cyan px-1">Browse the full voice list ↗</a>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Emotion */}
                  <div className="relative">
                    <button onClick={() => setShowVoiceMenu((v) => (v === 'emotion' ? null : 'emotion'))} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary" title="Emotion (only some voices)">
                      <span className="capitalize">{emotion || 'Emotion'}</span><ChevronDown size={11} />
                    </button>
                    {showVoiceMenu === 'emotion' && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setShowVoiceMenu(null)} />
                        <div className="absolute bottom-full mb-1.5 left-0 z-30 w-32 p-1 rounded-lg border border-border bg-elevated shadow-xl flex flex-col gap-0.5">
                          {EMOTIONS.map((e) => (
                            <button key={e || 'none'} onClick={() => { setEmotion(e); setShowVoiceMenu(null) }} className={cn('px-2 py-1 rounded text-[11px] text-left capitalize', emotion === e ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:bg-bg')}>{e || 'none'}</button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Speed */}
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted" title="Speech rate (−50 … 100)">
                    <span className="font-mono text-text-dim w-7">{speechRate > 0 ? `+${speechRate}` : speechRate}</span>
                    <input type="range" min={-50} max={100} value={speechRate} onChange={(e) => setSpeechRate(Number(e.target.value))} className="w-16 accent-cyan" />
                  </div>
                </>
              )}

              </div>

              {/* Actions — outside the wrapping column, so they are always on the top line. */}
              <div className="shrink-0 flex items-center gap-1.5">
                {genType !== 'voice' && (
                <button
                  onClick={() => void enhance()}
                  disabled={!canEnhance}
                  data-testid="studio-enhance"
                  title="Enhance the prompt with Claude — tuned for Seedream 5.0"
                  className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-colors',
                    canEnhance ? 'border-amber/50 text-amber bg-amber/5 hover:bg-amber/15' : 'border-border text-text-dim cursor-not-allowed')}
                >
                  {enhancing ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
                  Enhance
                </button>
                )}
                <button
                  onClick={generate}
                  disabled={!canGenerate}
                  data-testid="studio-generate"
                  className={cn('flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-semibold transition-colors',
                    canGenerate ? 'bg-cyan text-bg hover:bg-cyan/90' : 'bg-elevated text-text-dim cursor-not-allowed border border-border')}
                >
                  <Sparkles size={13} />
                  Generate
                </button>
                {/* In-flight count. It used to ride INSIDE the button label as
                    "Generate (1)", which reads as "generate 1 image" — it actually means
                    one generation is still running, so it lives beside the button now. */}
                {pendingGens.length > 0 && (
                  <span title={`${pendingGens.length} generation(s) still rendering`}
                    data-testid="studio-inflight"
                    className="flex items-center gap-1 px-1.5 py-1 rounded-lg border border-cyan/30 bg-cyan/5 text-[11px] font-mono text-cyan">
                    <Loader2 size={11} className="animate-spin" />{pendingGens.length}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Gallery (right) — own persisted store ───────────────────────────── */}
      <div className="w-56 shrink-0 border-l border-border bg-surface flex flex-col" data-testid="studio-gallery">
        <div className="flex flex-col gap-1.5 px-3 py-2 border-b border-border shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold tracking-widest text-text-muted uppercase">Gallery</span>
            {items.length > 0 && (
              /* Scoped to what you are LOOKING at: a trash icon that wiped every kind
                 while the gallery showed only videos was a trap. */
              <button
                onClick={() => {
                  if (galleryKind === 'all') clearAll(); else clearKind(galleryKind)
                  setActiveId(null)
                }}
                data-testid="studio-gallery-clear"
                className="text-text-muted hover:text-red"
                title={galleryKind === 'all' ? 'Clear the whole gallery' : `Clear ${galleryKind}s only`}
              ><Trash2 size={12} /></button>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            {GALLERY_TABS.map((t) => {
              const n = t.id === 'all' ? items.length : items.filter((i) => i.kind === t.id).length
              return (
                <button key={t.id} onClick={() => setGalleryKind(t.id)}
                  data-testid={`gallery-tab-${t.id}`} title={t.title}
                  className={cn('flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors',
                    galleryKind === t.id ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:text-text-primary')}>
                  {t.icon ? <t.icon size={10} /> : t.label}
                  <span className="font-mono opacity-70">{n}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 grid grid-cols-2 gap-2 content-start">
          {galleryItems.length === 0 ? (
            <p className="col-span-2 text-[10px] text-text-dim text-center mt-6 px-2">
              {items.length === 0
                ? 'Your generations will appear here — saved locally, independent of any project.'
                : `No ${galleryKind}s yet.`}
            </p>
          ) : (
            galleryItems.map((it) => {
              const multi = it.imageUrls.length > 1
              const isActive = activeId === it.id
              const borderCls = isActive ? 'border-cyan ring-1 ring-cyan' : 'border-border group-hover:border-cyan/40'
              const Poster = (
                it.posterUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.posterUrl} alt={it.prompt} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-text-dim bg-elevated">{it.kind === 'audio' ? <Music size={16} /> : <ImageIcon size={16} />}</div>
                )
              )
              return (
                <button
                  key={it.id}
                  onClick={() => scrollToEntry(it.id)}
                  data-testid={`studio-item-${it.id}`}
                  className="relative group aspect-square"
                  title={`${it.prompt}${multi ? ` · ${it.imageUrls.length} images` : ''}`}
                >
                  {multi ? (
                    <>
                      <span className="absolute top-0 right-0 w-[86%] h-[86%] rounded-lg border border-border bg-elevated" />
                      <span className="absolute top-[5px] right-[5px] w-[86%] h-[86%] rounded-lg border border-border bg-surface" />
                      <span className={cn('absolute bottom-0 left-0 w-[86%] h-[86%] rounded-lg overflow-hidden border', borderCls)}>{Poster}</span>
                      <span className="absolute bottom-1 left-1 px-1 rounded bg-bg/80 text-[9px] font-semibold text-text-primary leading-tight">{it.imageUrls.length}</span>
                    </>
                  ) : (
                    <span className={cn('absolute inset-0 rounded-lg overflow-hidden border', borderCls)}>{Poster}</span>
                  )}
                  {it.kind === 'video' && <Film size={11} className="absolute bottom-1 right-1 text-white drop-shadow" />}
                  {/* Clicking the thumb scrolls to the entry; the magnifier opens it full size. */}
                  {it.kind === 'image' && it.imageUrls[0] && (
                    <span
                      onClick={(e) => { e.stopPropagation(); setZoomUrl(it.imageUrls[0]) }}
                      data-testid={`studio-gallery-zoom-${it.id}`}
                      title="View full size"
                      className="absolute top-1 left-1 z-10 p-0.5 rounded bg-bg/80 text-text-muted opacity-0 group-hover:opacity-100 hover:text-cyan"
                    ><Maximize2 size={11} /></span>
                  )}
                  <span
                    onClick={(e) => { e.stopPropagation(); removeItem(it.id); if (isActive) setActiveId(null) }}
                    data-testid={`studio-remove-${it.id}`}
                    className="absolute top-1 right-1 z-10 p-0.5 rounded bg-bg/80 text-text-muted opacity-0 group-hover:opacity-100 hover:text-red"
                    title="Remove generation"
                  ><X size={11} /></span>
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* C: Extend / Edit panel for the selected clip. */}
      {vidActionFor && (
        <>
          <div className="fixed inset-0 z-40 bg-bg/70" onClick={() => setVidActionFor(null)} />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[420px] p-4 rounded-xl border border-border bg-surface shadow-2xl flex flex-col gap-3"
            data-testid="studio-video-action">
            <p className="text-[12px] font-semibold text-text-primary">
              {vidActionFor.kind === 'extend' ? 'Extend clip' : vidActionFor.kind === 'upscale' ? 'Upscale clip' : 'Edit clip'}
            </p>
            {vidActionFor.kind === 'extend' ? (
              <>
                {/* What happens NEXT in the continuation — Seedance gets this as the
                    director note on top of the last frame. Optional: empty = just carry on. */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">What happens next</span>
                    <button
                      onClick={() => { void (async () => { const r = await enhanceText(extendNote, 'video'); if (r) setExtendNote(r) })() }}
                      disabled={enhancing || !extendNote.trim()}
                      data-testid="studio-extend-enhance"
                      title="Enhance this direction"
                      className="ml-auto flex items-center gap-1 text-[10px] text-text-muted hover:text-cyan disabled:opacity-40"
                    ><Wand2 size={11} />{enhancing ? 'Enhancing…' : 'Enhance'}</button>
                  </div>
                  <textarea value={extendNote} onChange={(e) => setExtendNote(e.target.value)} rows={2}
                    placeholder="Optional — e.g. she turns and walks toward the door as the light fades"
                    data-testid="studio-extend-note"
                    className="w-full px-2 py-1.5 rounded bg-elevated border border-border text-[11px] text-text-primary placeholder:text-text-dim outline-none resize-none" />
                </div>
                <label className="flex items-center gap-2 text-[11px] text-text-muted">
                  Seconds
                  <input type="number" min={4} max={15} value={extendSecs}
                    onChange={(e) => setExtendSecs(Math.max(4, Math.min(15, Number(e.target.value) || 5)))}
                    data-testid="studio-extend-secs"
                    className="w-16 px-2 py-1 rounded bg-elevated border border-border text-text-primary outline-none" />
                  <span className="text-text-dim">Seedance allows 4–15s per render</span>
                </label>
                <button onClick={() => setExtendConcat((v) => !v)} data-testid="studio-extend-concat"
                  className={cn('flex items-center gap-2 px-2 py-1.5 rounded-lg border text-[11px] text-left',
                    extendConcat ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-border text-text-muted')}>
                  <span className={cn('w-3 h-3 rounded-sm border', extendConcat ? 'bg-cyan border-cyan' : 'border-text-dim')} />
                  Join onto the original (one longer clip)
                  <span className="ml-auto text-text-dim">{extendConcat ? 'on' : 'off'}</span>
                </button>
                <p className="text-[10px] text-text-dim leading-relaxed">
                  Continues from this clip&apos;s own last frame, so the look carries over. Off = the
                  continuation is a separate new clip.
                </p>
              </>
            ) : vidActionFor.kind === 'upscale' ? (
              <>
                <p className="text-[10px] text-text-dim leading-relaxed">
                  AI MediaKit re-renders this clip at a higher resolution — super-resolution, denoise, colour — on
                  its AIGC preset. Standard is the everyday tier; Professional is large-model restoration at 10× the price.
                </p>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Resolution</span>
                  <div className="flex items-center gap-1">
                    {UPSCALE_RES.map((o) => (
                      <button key={o.id} onClick={() => { setUpRes(o.id); setUpQuote(null) }} data-testid={`studio-upscale-res-${o.id}`} aria-pressed={upRes === o.id}
                        className={cn('px-2 py-1 rounded-lg border text-[11px]', upRes === o.id ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-border text-text-muted hover:text-text-primary')}>{o.label}</button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Tier</span>
                  <div className="flex items-center gap-1">
                    {UPSCALE_TIERS.map((o) => (
                      <button key={o.id} onClick={() => { setUpTier(o.id); setUpQuote(null) }} data-testid={`studio-upscale-tier-${o.id}`} aria-pressed={upTier === o.id}
                        className={cn('px-2 py-1 rounded-lg border text-[11px]', upTier === o.id ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-border text-text-muted hover:text-text-primary')}>{o.label}</button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Style</span>
                  <div className="flex items-center gap-1">
                    {UPSCALE_STYLES.map((o) => (
                      <button key={o.id} onClick={() => setUpStyle(o.id)} data-testid={`studio-upscale-style-${o.id}`} aria-pressed={upStyle === o.id}
                        className={cn('px-2 py-1 rounded-lg border text-[11px]', upStyle === o.id ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-border text-text-muted hover:text-text-primary')}>{o.label}</button>
                    ))}
                  </div>
                </div>
                <p className="text-[11px] text-text-muted" data-testid="studio-upscale-quote">
                  {upQuote === null ? 'Pricing…' : upQuote.usd < 0 ? 'Price unavailable'
                    : `${upQuote.seconds.toFixed(1)}s · $${upQuote.usd.toFixed(2)} — output minutes × the published coefficient`}
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">The change</span>
                  <button
                    onClick={() => { void (async () => { const r = await enhanceText(vidEditNote, 'refine'); if (r) setVidEditNote(r) })() }}
                    disabled={enhancing || !vidEditNote.trim()}
                    data-testid="studio-vedit-enhance"
                    title="Enhance this edit instruction"
                    className="ml-auto flex items-center gap-1 text-[10px] text-text-muted hover:text-cyan disabled:opacity-40"
                  ><Wand2 size={11} />{enhancing ? 'Enhancing…' : 'Enhance'}</button>
                </div>
                <textarea value={vidEditNote} onChange={(e) => setVidEditNote(e.target.value)} rows={3}
                  placeholder="What should change? e.g. add three ships on the horizon"
                  data-testid="studio-vedit-note"
                  className="w-full px-2 py-1.5 rounded bg-elevated border border-border text-[11px] text-text-primary placeholder:text-text-dim outline-none resize-none" />
                <p className="text-[10px] text-text-dim leading-relaxed">
                  Keeps the subject, framing, performance and camera move — changes only what you describe.
                </p>
              </>
            )}
            <div className="flex items-center gap-2">
              <button onClick={() => setVidActionFor(null)} className="px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary">Cancel</button>
              <button
                data-testid="studio-video-action-run"
                onClick={() => {
                  const { item, kind } = vidActionFor
                  setVidActionFor(null)
                  if (kind === 'extend') { const n = extendNote; setExtendNote(''); void extendVideo(item, extendSecs, extendConcat, n) }
                  else if (kind === 'upscale') { void runUpscale(item) }
                  else { const n = vidEditNote; setVidEditNote(''); void editVideo(item, n) }
                }}
                className="ml-auto px-3 py-1 rounded-lg border border-cyan/50 bg-cyan/15 text-[11px] font-semibold text-cyan hover:bg-cyan/25"
              >{vidActionFor.kind === 'extend' ? 'Extend' : vidActionFor.kind === 'upscale' ? 'Upscale' : 'Apply edit'}</button>
            </div>
          </div>
        </>
      )}

      {/* Full-size viewer — click any generation to open, click the backdrop or Esc to close. */}
      {zoomUrl && (
        <div className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setZoomUrl(null)} data-testid="studio-lightbox">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomUrl} alt="Full size" onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded shadow-2xl cursor-default" />
          <button onClick={() => setZoomUrl(null)} title="Close"
            data-testid="studio-lightbox-close"
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20">
            <X size={18} />
          </button>
        </div>
      )}

      {/* Animate a still with Seedance (i2v). The clip lands as a NEW gallery item. */}
      {animateFor && (
        <AnimatePanel
          image={animateFor.url}
          title={animateFor.item.prompt.slice(0, 40) || 'image'}
          onClose={() => setAnimateFor(null)}
          onGenerate={({ prompt: p, duration: d, resolution: r, genAudio: ga, tier: tr }) =>
            void runVideoGeneration({
              prompt: p, mode: 'i2v', images: [animateFor.url],
              // The clip inherits the still's shape — asking again would be noise.
              ratio: ratioOf(animateFor.item), resolution: r, duration: d, genAudio: ga, tier: tr,
            })}
        />
      )}

      {/* AI Character Creator — structured fields → the pipeline's own sheet prompt
          builder → a normal Studio generation. */}
      {charCreatorOpen && (
        <CharacterCreator
          onClose={() => setCharCreatorOpen(false)}
          galleryImages={items.filter((i) => i.kind === 'image' && i.imageUrls[0])
            .slice(0, 30).map((i) => ({ id: i.id, url: i.imageUrls[0], prompt: i.prompt }))}
          onGenerate={(req) => void runGeneration({
            // The pending card reads the DESCRIPTION, which is what the director wrote;
            // the assembled sheet prompt (thousands of characters) replaces it on the
            // finished card, where the "sent verbatim" text belongs.
            prompt: req.description,
            prepare: async () => {
              // The sheet prompt is built by the SAME backend builder the pipeline uses.
              const { data } = await apiClient.post<{ board_prompt?: string }>(
                '/api/assets/board-prompt',
                {
                  asset_name: req.kind === 'prop' ? 'Studio prop' : req.kind === 'wardrobe' ? 'Studio outfit' : 'Studio character',
                  description: req.description, kind: req.kind,
                  layout: req.layout, grey_bg: req.greyBg, pose_labels: req.poseLabels,
                },
                { timeout: 120_000 },
              )
              return data.board_prompt ?? ''
            },
            // NOTE: no reference images — identity rides as TEXT (face-safe path).
            refImages: [], ratio: '16:9', count: req.count, model: req.model, quality: '2K',
          })}
        />
      )}

      {/* B: the pipeline's Seedream 5.0 Pro editor, reused verbatim. Studio edits are
          written under Studio/Images, so nothing lands in the project's asset folders. */}
      {proEditFor && (
        <ProImageEditor
          title={`Studio · ${proEditFor.item.prompt.slice(0, 40) || 'image'}`}
          baseImage={proEditFor.url}
          assetRelPath="Studio/Images"
          projectName={projectName || '_studio'}
          projectPath={projectPath ?? ''}
          onClose={() => setProEditFor(null)}
          onApplied={(edited) => onProEditApplied(proEditFor.item, edited)}
        />
      )}
    </div>
  )
}
