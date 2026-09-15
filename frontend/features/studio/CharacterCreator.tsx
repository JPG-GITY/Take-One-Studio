'use client'

import { useState, useRef, useCallback } from 'react'
import { X, Upload, Images, Sparkles, Wand2, Loader2, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { pipelineApi } from '@/lib/api/pipeline.api'
import type { StudioItem } from '@/store/studio.store'

/** Sheet layouts offered here. 'headless' is the backend default and the sheet the
 *  pipeline's AG produces: ONE face on the whole sheet, because a wide shot was taking
 *  the face off a tiny full-body figure instead of the portrait (HELL GRIND rule 1 —
 *  see _SHEET_LAYOUTS in claude_agents.py). The two turnarounds are kept because a
 *  wardrobe/silhouette review still wants four sides of the costume. */
const LAYOUTS = [
  { id: 'headless', label: '1 face', hint: '3/4 portrait + headless front + back' },
  { id: '2+2', label: '4 panels', hint: '2 full-body + 2 face close-ups' },
  { id: '4+2', label: '6 panels', hint: '4 full-body + 2 face close-ups' },
] as const
export type Layout = (typeof LAYOUTS)[number]['id']

/** Item sheets reuse the backend's prop/wardrobe sheet builders. */
const ITEM_KINDS = [
  { id: 'wardrobe', label: 'Outfit' },
  { id: 'prop', label: 'Prop / accessory' },
] as const

interface Props {
  onClose: () => void
  /** Studio images available as a reference photo (gallery picker). */
  galleryImages: Array<{ id: string; url: string; prompt: string }>
  /** Hands the sheet REQUEST to the Studio, which writes the prompt and generates on its
   *  own pending card. Not a finished prompt: building one is a ~1-2 min backend call, and
   *  doing it here is what kept this modal on screen — see `run`. */
  onGenerate: (opts: {
    kind: 'character' | 'prop' | 'wardrobe'
    description: string
    layout: Layout
    greyBg: boolean
    poseLabels: boolean
    count: number
    model: 'pro' | 'lite'
  }) => void
}

const FIELDS = [
  { key: 'character', label: 'Character (identity / face / hair / body)', ph: 'e.g. man in his 30s, lean build, curly dark hair, thin moustache', rows: 3 },
  { key: 'wardrobe', label: 'Wardrobe (shirt / pants / skirt…)', ph: 'e.g. oversized washed-charcoal tee, baggy black cargo denim', rows: 2 },
  { key: 'shoes', label: 'Shoes (type)', ph: 'e.g. black chunky leather low shoes', rows: 2 },
  { key: 'props', label: 'Props (caps / glasses / scarf / jewellery…)', ph: 'e.g. small silver hoop earrings, thin neck chain — or leave empty', rows: 2 },
] as const
type FieldKey = (typeof FIELDS)[number]['key']

/**
 * AI Character Creator — describe a character in structured fields and render a
 * multi-pose reference sheet with Seedream.
 *
 * FACE-SAFE BY DESIGN: an uploaded photo is only ever DESCRIBED into the text fields
 * (vision → words) and is NEVER attached as an image reference. That keeps a real face
 * out of the generation, which is what makes the resulting sheet usable downstream —
 * Seedance rejects references carrying unverified real faces (video-seedance §7).
 */
export function CharacterCreator({ onClose, galleryImages, onGenerate }: Props) {
  const [fields, setFields] = useState<Record<FieldKey, string>>({
    character: '', wardrobe: '', shoes: '', props: '',
  })
  const [photo, setPhoto] = useState<{ url: string; name: string } | null>(null)
  const [showGallery, setShowGallery] = useState(false)
  const [busy, setBusy] = useState<'' | 'autofill' | FieldKey>('')
  const [error, setError] = useState<string | null>(null)

  const [layout, setLayout] = useState<Layout>('headless')
  const [greyBg, setGreyBg] = useState(true)
  const [noLabels, setNoLabels] = useState(false)
  const [variations, setVariations] = useState(2)
  const [model, setModel] = useState<'pro' | 'lite'>('pro')

  const fileRef = useRef<HTMLInputElement>(null)
  const set = (k: FieldKey, v: string) => setFields((f) => ({ ...f, [k]: v }))

  const pickFile = useCallback(async (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => setPhoto({ url: String(reader.result), name: f.name })
    reader.readAsDataURL(f)
  }, [])

  /** Vision-read the photo into the fields. The photo itself never leaves this panel. */
  const autoFill = useCallback(async () => {
    if (!photo) { setError('Add a reference photo first.'); return }
    setBusy('autofill'); setError(null)
    try {
      const r = await pipelineApi.describeCharacterRefs([photo.url])
      setFields({
        character: [r.appearance, r.hairstyle].filter(Boolean).join('. '),
        wardrobe: r.wardrobe ?? '',
        shoes: r.shoes ?? '',
        props: r.props ?? '',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the photo')
    } finally { setBusy('') }
  }, [photo])

  const enhance = useCallback(async (k: FieldKey) => {
    const cur = fields[k]
    if (!cur.trim()) { setError('Write something in the field first, then Enhance.'); return }
    setBusy(k); setError(null)
    try {
      const label = FIELDS.find((f) => f.key === k)!.label
      // Context = the other fields, so an enhanced wardrobe still matches the person.
      const ctx = FIELDS.filter((f) => f.key !== k && fields[f.key].trim())
        .map((f) => `${f.label}: ${fields[f.key]}`).join('\n')
      const out = await pipelineApi.enhanceText(`a character sheet's "${label}" field`, cur, ctx)
      if (out) set(k, out)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enhance failed')
    } finally { setBusy('') }
  }, [fields])

  /** The description each sheet kind needs. A character sheet wants the whole person,
   *  but an ITEM sheet must describe ONLY that item — feeding it every field rendered the
   *  outfit sheet with the character's props (and vice versa) instead of the garment alone. */
  const description = useCallback((kind: 'character' | 'prop' | 'wardrobe') => {
    if (kind === 'wardrobe') return [
      fields.wardrobe.trim(),
      fields.shoes.trim() && `Shoes: ${fields.shoes.trim()}`,   // footwear is part of the outfit
    ].filter(Boolean).join('. ')
    if (kind === 'prop') return fields.props.trim()
    return [
      fields.character.trim(),
      fields.wardrobe.trim() && `Wardrobe: ${fields.wardrobe.trim()}`,
      fields.shoes.trim() && `Shoes: ${fields.shoes.trim()}`,
      fields.props.trim() && `Props: ${fields.props.trim()}`,
    ].filter(Boolean).join('. ')
  }, [fields])

  // FIRE AND FORGET. This used to build the sheet prompt here — a backend call with a
  // 120 s timeout — and only close once it answered, so the modal sat on screen spinning
  // and the Studio was unusable meanwhile. The request goes to the Studio, which shows it
  // as a pending card in the timeline and reports its own errors; this closes at once.
  const run = useCallback((kind: 'character' | 'prop' | 'wardrobe') => {
    const desc = description(kind)
    if (!desc) {
      setError(kind === 'prop' ? 'Fill in the Props field to render a prop sheet.'
        : kind === 'wardrobe' ? 'Fill in the Wardrobe field to render an outfit sheet.'
        : 'Describe the character first (or auto-fill from a photo).')
      return
    }
    onGenerate({
      kind, description: desc, layout, greyBg, poseLabels: !noLabels,
      count: variations, model,
    })
    onClose()
  }, [description, layout, greyBg, noLabels, variations, model, onGenerate, onClose])

  return (
    <>
      <div className="fixed inset-0 z-40 bg-bg/80" onClick={onClose} />
      <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] max-h-[88vh] overflow-y-auto rounded-xl border border-border bg-surface shadow-2xl"
        data-testid="character-creator">
        <div className="sticky top-0 flex items-center gap-2 px-4 py-3 border-b border-border bg-surface">
          <UserPlus size={14} className="text-cyan" />
          <p className="text-[12px] font-semibold text-text-primary flex-1">AI Character Creator</p>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={15} /></button>
        </div>

        <div className="p-4 flex flex-col gap-4">
          {/* Reference photo → fields. Never used as an image reference. */}
          <section className="flex flex-col gap-2">
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
              Describe from a photo (optional)
            </p>
            <p className="text-[10px] text-text-dim leading-relaxed">
              The photo is only described into the fields below — it is never used as an image
              reference, so no real face reaches the model.
            </p>
            <div className="flex items-center gap-2">
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { void pickFile(e.target.files); e.target.value = '' }} />
              <button onClick={() => fileRef.current?.click()} data-testid="cc-browse"
                className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary">
                <Upload size={11} />Browse
              </button>
              <button onClick={() => setShowGallery((v) => !v)} data-testid="cc-from-gallery"
                disabled={!galleryImages.length}
                title={galleryImages.length ? 'Pick a Studio image' : 'No Studio images yet'}
                className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40">
                <Images size={11} />From gallery
              </button>
              <button onClick={() => void autoFill()} disabled={!photo || busy === 'autofill'}
                data-testid="cc-autofill"
                className="flex items-center gap-1 px-2 py-1 rounded-lg border border-cyan/40 bg-cyan/5 text-[11px] text-cyan hover:bg-cyan/15 disabled:opacity-40">
                {busy === 'autofill' ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                Auto-fill fields
              </button>
              <button onClick={() => { setFields({ character: '', wardrobe: '', shoes: '', props: '' }); setPhoto(null) }}
                data-testid="cc-clear"
                className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-red hover:border-red/40">
                <X size={11} />Clear
              </button>
            </div>
            {photo && (
              <div className="flex items-center gap-2 text-[10px] text-text-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.url} alt="reference" className="w-12 h-12 object-cover rounded border border-border" />
                <span className="truncate">{photo.name}</span>
              </div>
            )}
            {showGallery && galleryImages.length > 0 && (
              <div className="grid grid-cols-5 gap-1 p-1.5 rounded-lg border border-border bg-elevated max-h-32 overflow-y-auto">
                {galleryImages.map((g) => (
                  <button key={g.id} onClick={() => { setPhoto({ url: g.url, name: g.prompt.slice(0, 24) || 'studio image' }); setShowGallery(false) }}
                    className="aspect-square rounded overflow-hidden border border-border hover:border-cyan/60">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.url} alt={g.prompt} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* The four description fields, each with Enhance. */}
          {FIELDS.map((f) => (
            <section key={f.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest flex-1">{f.label}</p>
                <button onClick={() => void enhance(f.key)} disabled={busy === f.key}
                  data-testid={`cc-enhance-${f.key}`}
                  className="flex items-center gap-1 text-[10px] text-text-muted hover:text-cyan disabled:opacity-40">
                  {busy === f.key ? <Loader2 size={10} className="animate-spin" /> : <Wand2 size={10} />}Enhance
                </button>
              </div>
              <textarea value={fields[f.key]} onChange={(e) => set(f.key, e.target.value)} rows={f.rows}
                placeholder={f.ph} data-testid={`cc-field-${f.key}`}
                className="w-full px-2 py-1.5 rounded bg-elevated border border-border text-[11px] text-text-primary placeholder:text-text-dim outline-none focus:border-cyan/50 resize-none" />
            </section>
          ))}

          {/* Sheet options */}
          <section className="flex flex-col gap-2 border-t border-border pt-3">
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Sheet</p>
            <div className="flex items-center gap-2">
              {LAYOUTS.map((l) => (
                <button key={l.id} onClick={() => setLayout(l.id)} data-testid={`cc-layout-${l.id}`}
                  title={l.hint}
                  className={cn('flex-1 px-2 py-1.5 rounded-lg border text-[11px] text-left',
                    layout === l.id ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-border text-text-muted hover:text-text-primary')}>
                  <span className="font-semibold">{l.label}</span>
                  <span className="block text-[9px] opacity-70">{l.hint}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {([['grey', 'Grey seamless background', greyBg, setGreyBg],
                 ['labels', 'No text labels on panels', noLabels, setNoLabels]] as const).map(([id, label, val, setter]) => (
                <button key={id} onClick={() => (setter as (v: boolean) => void)(!val)}
                  data-testid={`cc-toggle-${id}`}
                  className="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text-primary">
                  <span className={cn('w-3 h-3 rounded-sm border', val ? 'bg-cyan border-cyan' : 'border-text-dim')} />
                  {label}
                </button>
              ))}
              <label className="flex items-center gap-1.5 text-[11px] text-text-muted ml-auto">
                Variations
                <input type="number" min={1} max={4} value={variations} data-testid="cc-variations"
                  onChange={(e) => setVariations(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
                  className="w-12 px-1.5 py-0.5 rounded bg-elevated border border-border text-text-primary outline-none" />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-muted">Model</span>
              {([['pro', 'Seedream 5.0 Pro'], ['lite', 'Seedream 5.0 Lite']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setModel(id)} data-testid={`cc-model-${id}`}
                  className={cn('px-2 py-1 rounded-lg border text-[11px]',
                    model === id ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-border text-text-muted hover:text-text-primary')}>
                  {label}
                </button>
              ))}
            </div>
          </section>

          {error && <p className="text-[11px] text-red">{error}</p>}

          <div className="flex items-center gap-2 border-t border-border pt-3">
            <button onClick={() => run('character')}
              data-testid="cc-generate-character"
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-cyan/50 bg-cyan/15 text-[11px] font-semibold text-cyan hover:bg-cyan/25 disabled:opacity-50">
              <Sparkles size={12} />
              Generate character sheet
            </button>
          </div>
          {/* Item sheets are two INDEPENDENT actions, not one action with a picker: an
              outfit and a prop are different deliverables and you usually want both. */}
          <div className="flex items-center gap-2">
            {ITEM_KINDS.map((k) => (
              <button key={k.id} onClick={() => run(k.id)}
                data-testid={`cc-generate-${k.id}`}
                title={k.id === 'wardrobe'
                  ? 'Render the outfit alone on grey (uses the Wardrobe + Shoes fields)'
                  : 'Render the prop alone on grey (uses the Props field)'}
                className="flex-1 px-3 py-1.5 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary hover:border-text-dim disabled:opacity-50">
                {k.label} sheet
              </button>
            ))}
          </div>
          <p className="text-[9px] text-text-dim leading-relaxed">
            Character sheets use the face-safe text-to-image path: the identity rides as words,
            never as a photo. Item sheets render the garment or prop alone on grey.
          </p>
        </div>
      </div>
    </>
  )
}

export type { StudioItem }
