'use client'

import { useState, useRef, useEffect } from 'react'
import { Palette, ChevronDown, Check, X, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STYLE_PRESETS, CUSTOM_STYLE_DEFAULT } from '@/lib/styles'
import { usePipelineStore } from '@/store/pipeline.store'
import type { ProjectStyle, StyleId } from '@/lib/types/pipeline.types'

const STYLE_COLORS: Record<StyleId, string> = {
  cinematic:  'text-amber  border-amber/30  bg-amber/10',
  photoreal:  'text-cyan   border-cyan/30   bg-cyan/10',
  anime:      'text-pink-400 border-pink-400/30 bg-pink-400/10',
  pixar3d:    'text-orange border-orange/30 bg-orange/10',
  cartoon2d:  'text-green  border-green/30  bg-green/10',
  comic:      'text-red    border-red/30    bg-red/10',
  custom:     'text-text-muted border-border bg-elevated',
}

export function StyleSelector({ compact = false }: { compact?: boolean }) {
  // Split into separate selectors — object literals return a new ref every render
  // and cause the "getServerSnapshot should be cached" infinite-loop in Zustand v5.
  const style    = usePipelineStore((s) => s.style)
  const setStyle = usePipelineStore((s) => s.setStyle)
  const [open, setOpen] = useState(false)
  const [customSuffix, setCustomSuffix] = useState(style.id === 'custom' ? style.promptSuffix : '')
  const [customNeg, setCustomNeg] = useState(style.id === 'custom' ? style.negativePrompt : '')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const selectPreset = (id: Exclude<StyleId, 'custom'>) => {
    setStyle(STYLE_PRESETS[id])
    setOpen(false)
  }

  const applyCustom = () => {
    setStyle({ ...CUSTOM_STYLE_DEFAULT, promptSuffix: customSuffix, negativePrompt: customNeg })
    setOpen(false)
  }

  const colorClass = STYLE_COLORS[style.id] ?? STYLE_COLORS.custom

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-semibold transition-all',
          'hover:brightness-110',
          colorClass,
        )}
      >
        <Palette size={11} />
        {compact ? null : <span>{style.label}</span>}
        {!compact && <ChevronDown size={10} className="opacity-60" />}
      </button>

      {/* Dropdown */}
      {open && (
        <div className={cn(
          'absolute top-full mt-1 z-50',
          compact ? 'right-0' : 'left-0',
          'w-72 bg-surface border border-border rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden',
        )}>
          <div className="px-3 py-2 border-b border-border">
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Project Visual Style</p>
          </div>

          {/* Preset list */}
          <div className="p-2 flex flex-col gap-1">
            {(Object.values(STYLE_PRESETS) as ProjectStyle[]).map((preset) => (
              <button
                key={preset.id}
                onClick={() => selectPreset(preset.id as Exclude<StyleId, 'custom'>)}
                className={cn(
                  'flex items-start gap-2.5 w-full text-left px-3 py-2 rounded-md transition-colors',
                  style.id === preset.id
                    ? 'bg-elevated border border-border'
                    : 'hover:bg-elevated/60',
                )}
              >
                <div className={cn('w-2 h-2 rounded-full mt-1 shrink-0', {
                  'bg-amber':      preset.id === 'cinematic',
                  'bg-cyan':       preset.id === 'photoreal',
                  'bg-pink-400':   preset.id === 'anime',
                  'bg-orange':     preset.id === 'pixar3d',
                  'bg-green':      preset.id === 'cartoon2d',
                  'bg-red':        preset.id === 'comic',
                })} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-text-primary">{preset.label}</span>
                    {style.id === preset.id && <Check size={11} className="text-cyan shrink-0" />}
                  </div>
                  <p className="text-[10px] text-text-muted mt-0.5 line-clamp-2 leading-relaxed">
                    {preset.promptSuffix.split(',').slice(0, 3).join(', ')}…
                  </p>
                </div>
              </button>
            ))}
          </div>

          {/* Custom section */}
          <div className="border-t border-border p-3">
            <button
              onClick={() => style.id !== 'custom' && setStyle({ ...CUSTOM_STYLE_DEFAULT })}
              className={cn(
                'flex items-center gap-2 w-full text-left px-3 py-2 rounded-md mb-2 transition-colors text-xs font-semibold text-text-muted',
                style.id === 'custom' ? 'bg-elevated border border-border text-text-primary' : 'hover:bg-elevated/60',
              )}
            >
              <div className="w-2 h-2 rounded-full bg-text-muted shrink-0" />
              Custom
              {style.id === 'custom' && <Check size={11} className="text-cyan ml-auto" />}
            </button>

            {style.id === 'custom' && (
              <div className="flex flex-col gap-2">
                <div>
                  <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest block mb-1">
                    Style Prompt Suffix
                  </label>
                  <textarea
                    value={customSuffix}
                    onChange={(e) => setCustomSuffix(e.target.value)}
                    placeholder="e.g. cyberpunk neon noir, rain-soaked streets, neon reflections…"
                    rows={2}
                    className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/40 resize-none"
                  />
                </div>
                <div>
                  <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest block mb-1">
                    Negative Prompt
                  </label>
                  <textarea
                    value={customNeg}
                    onChange={(e) => setCustomNeg(e.target.value)}
                    placeholder="e.g. blurry, low quality, cartoon…"
                    rows={1}
                    className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-red/40 resize-none"
                  />
                </div>
                <button
                  onClick={applyCustom}
                  className="w-full py-1.5 rounded bg-cyan/10 text-cyan text-[11px] font-semibold border border-cyan/30 hover:bg-cyan/20 transition-colors"
                >
                  Apply Custom Style
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
