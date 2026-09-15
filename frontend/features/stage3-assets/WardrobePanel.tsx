'use client'

import { useState } from 'react'
import { Shirt, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import type { Asset, Scene } from '@/lib/types/pipeline.types'

interface Props {
  /** The base character. Its own `wardrobe` is the DEFAULT look (worn wherever no
   *  variant claims the scene). */
  base: Asset
  /** Wardrobe variants of this character (assets with parentCharacterId === base.id). */
  variants: Asset[]
  /** Every scene in the breakdown — the picker assigns looks by scene. */
  scenes: Scene[]
  onAdd: () => void
  onUpdate: (assetId: string, fields: Partial<Asset>) => void
  onRemove: (assetId: string) => void
  /** Stage approved → the breakdown is locked, so editing is read-only. */
  locked?: boolean
}

/** "Eli · Day Clothes" → "Day Clothes" (the part the user actually names). */
const labelOf = (variant: Asset, base: Asset): string => {
  const suffix = variant.name.startsWith(`${base.name} · `)
    ? variant.name.slice(base.name.length + 3)
    : variant.name
  return suffix.trim() || 'New look'
}

/**
 * Phase-2 (D2): the per-character WARDROBE editor. A character used to carry ONE costume
 * for the whole film, so a single reference sheet dressed them identically in every scene
 * (observed: Eli in pyjamas at school). Looks are detected from the script at breakdown
 * time, but the USER decides here — add, rename, re-describe, delete, and pick the scenes
 * each look is worn in. Assignments live on the variant's `sceneRefs`; the parent view
 * recomputes every shot's assetsUsed from them.
 */
export function WardrobePanel({ base, variants, scenes, onAdd, onUpdate, onRemove, locked }: Props) {
  const [open, setOpen] = useState(false)

  // A scene may only be claimed by ONE look of this character — showing which look already
  // owns it stops two variants silently fighting over the same shots.
  const ownerOf = new Map<string, Asset>()
  for (const v of variants) {
    for (const sid of v.sceneRefs ?? []) if (!ownerOf.has(sid)) ownerOf.set(sid, v)
  }

  const toggleScene = (variant: Asset, sceneId: string) => {
    const cur = variant.sceneRefs ?? []
    onUpdate(variant.id, {
      sceneRefs: cur.includes(sceneId) ? cur.filter((s) => s !== sceneId) : [...cur, sceneId],
    })
  }

  return (
    <div className="rounded-lg border border-cyan/20 bg-cyan/5 overflow-hidden" data-testid={`wardrobe-panel-${base.id}`}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-text-primary/[0.04] transition-colors"
      >
        <Shirt size={12} className="text-cyan" />
        <span className="text-[10px] font-semibold text-cyan uppercase tracking-widest flex-1 text-left">
          Wardrobe — {base.name}
        </span>
        <span className="text-[9px] font-mono text-cyan/60 bg-cyan/10 border border-cyan/20 px-1.5 py-0.5 rounded">
          {variants.length + 1} look{variants.length ? 's' : ''}
        </span>
        {open ? <ChevronUp size={12} className="text-text-muted" /> : <ChevronDown size={12} className="text-text-muted" />}
      </button>

      <div className={cn('grid transition-[grid-template-rows] duration-300 ease-in-out',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="overflow-hidden">
          <div className="border-t border-cyan/20 p-3 flex flex-col gap-3">
            {/* Default look — the base sheet. Worn in every scene no variant claims. */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-text-primary">Default look</span>
                <span className="text-[9px] text-text-muted">worn wherever no other look is assigned</span>
              </div>
              <textarea
                value={base.wardrobe ?? ''}
                onChange={(e) => onUpdate(base.id, { wardrobe: e.target.value })}
                disabled={locked}
                rows={2}
                placeholder="e.g. pale pink pyjamas, bare feet"
                data-testid={`wardrobe-default-${base.id}`}
                className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/50 resize-none disabled:opacity-60"
              />
            </div>

            {variants.map((v) => (
              <div key={v.id} className="flex flex-col gap-1.5 rounded border border-border bg-elevated/60 p-2">
                <div className="flex items-center gap-2">
                  <input
                    value={labelOf(v, base)}
                    onChange={(e) => onUpdate(v.id, { name: `${base.name} · ${e.target.value}` })}
                    disabled={locked}
                    placeholder="Look name (e.g. Day Clothes)"
                    data-testid={`wardrobe-label-${v.id}`}
                    className="flex-1 bg-surface border border-border rounded px-2 py-1 text-[11px] font-semibold text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/50 disabled:opacity-60"
                  />
                  <button
                    onClick={() => onRemove(v.id)}
                    disabled={locked}
                    title="Delete this look — its scenes fall back to the default look"
                    data-testid={`wardrobe-remove-${v.id}`}
                    className="shrink-0 p-1 rounded border border-border text-text-muted hover:text-red hover:border-red/50 transition-colors disabled:opacity-40"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>

                <textarea
                  value={v.wardrobe ?? ''}
                  onChange={(e) => onUpdate(v.id, { wardrobe: e.target.value })}
                  disabled={locked}
                  rows={2}
                  placeholder="Describe this outfit — e.g. navy school jumper, grey trousers, trainers"
                  data-testid={`wardrobe-desc-${v.id}`}
                  className="w-full bg-surface border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/50 resize-none disabled:opacity-60"
                />

                <div className="flex flex-col gap-1">
                  <span className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">
                    Worn in
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {scenes.map((sc) => {
                      const mine = (v.sceneRefs ?? []).includes(sc.id)
                      const owner = ownerOf.get(sc.id)
                      const takenByOther = !mine && !!owner && owner.id !== v.id
                      return (
                        <button
                          key={sc.id}
                          onClick={() => toggleScene(v, sc.id)}
                          disabled={locked || takenByOther}
                          title={takenByOther ? `Already assigned to "${labelOf(owner!, base)}"` : sc.heading}
                          data-testid={`wardrobe-scene-${v.id}-${sc.id}`}
                          className={cn(
                            'px-1.5 py-0.5 rounded border text-[9px] font-mono transition-colors disabled:opacity-40',
                            mine
                              ? 'border-cyan/60 bg-cyan/15 text-cyan'
                              : 'border-border bg-surface text-text-muted hover:text-text-primary',
                          )}
                        >
                          {sc.heading.slice(0, 28)}
                        </button>
                      )
                    })}
                  </div>
                  {!(v.sceneRefs ?? []).length && (
                    <span className="text-[9px] text-amber">
                      No scenes assigned — this look is never used. Pick at least one.
                    </span>
                  )}
                </div>
              </div>
            ))}

            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={12} />}
              onClick={onAdd}
              disabled={locked}
              data-testid={`wardrobe-add-${base.id}`}
              className="w-full"
            >
              Add a look
            </Button>
            <p className="text-[9px] text-text-muted leading-relaxed">
              Each look renders from {base.name}&apos;s approved sheet, so the face stays identical —
              only the clothes change. Approve the base character first.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
