'use client'

import { useState, useRef, useEffect } from 'react'
import { Settings, Moon, Sun, Monitor, Check, BarChart3, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useThemeStore, type Theme } from '@/store/theme.store'
import { usePipelineStore } from '@/store/pipeline.store'
import { UsagePanel } from '@/components/pipeline/UsagePanel'
import { ErrorLogPanel } from '@/components/pipeline/ErrorLogPanel'

const THEME_OPTS: Array<{ id: Theme; label: string; icon: React.ElementType }> = [
  { id: 'dark',   label: 'Dark',   icon: Moon },
  { id: 'light',  label: 'Light',  icon: Sun },
  { id: 'system', label: 'System', icon: Monitor },
]

type OutRes = '720p' | '1080p' | '4k'
const RES_OPTS: Array<{ id: OutRes; label: string; note: string }> = [
  { id: '720p',  label: '720p',  note: 'HD · fast' },
  { id: '1080p', label: '1080p', note: 'Full HD · 10-bit HEVC on 2.5' },
  { id: '4k',    label: '4K',    note: '10-bit HEVC · Seedance 2.0' },
]

type VidModel = 'v25' | 'base' | 'fast' | 'mini'
/** `maxRes` is the highest output size the model can actually render — used to WARN,
 *  never to block: the user picks the trade-off, not the app. `maxSecs` and `refs` are
 *  why 2.5 is the default — a longer single take and a bigger reference budget are what
 *  hold continuity (and locked voices) together across a scene. */
const MODEL_OPTS: Array<{ id: VidModel; label: string; note: string; maxRes: OutRes; maxSecs: number; refs: string }> = [
  { id: 'v25',  label: 'Seedance 2.5',      note: '30s takes · 50 refs · up to 1080p', maxRes: '1080p', maxSecs: 30, refs: '30 img · 10 vid · 10 audio' },
  { id: 'base', label: 'Seedance 2.0',      note: 'up to 4K · 15s',      maxRes: '4k',   maxSecs: 15, refs: '9 img · 3 vid · 3 audio' },
  { id: 'fast', label: 'Seedance 2.0 Fast', note: 'quicker · 15s',       maxRes: '720p', maxSecs: 15, refs: '9 img · 3 vid · 3 audio' },
  { id: 'mini', label: 'Seedance 2.0 Mini', note: 'cheapest · 15s',      maxRes: '720p', maxSecs: 15, refs: '9 img · 3 vid · 3 audio' },
]
const RES_ORDER: OutRes[] = ['720p', '1080p', '4k']
/** True when the chosen output size is above what the chosen model can render. */
const resExceedsModel = (res: OutRes, model: VidModel) => {
  const cap = MODEL_OPTS.find((m) => m.id === model)?.maxRes ?? '4k'
  return RES_ORDER.indexOf(res) > RES_ORDER.indexOf(cap)
}

export function SettingsMenu() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const outputResolution = usePipelineStore((s) => s.outputResolution)
  const setOutputResolution = usePipelineStore((s) => s.setOutputResolution)
  const videoModel = usePipelineStore((s) => s.videoModel)
  const setVideoModel = usePipelineStore((s) => s.setVideoModel)
  const [open, setOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [errorsOpen, setErrorsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        data-testid="settings-button"
        title="Settings"
        className={cn(
          'p-1.5 rounded transition-colors',
          open ? 'text-cyan bg-elevated' : 'text-text-muted hover:text-text-primary hover:bg-elevated',
        )}
      >
        <Settings size={14} />
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 z-50 w-52 bg-surface border border-border rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden">
          <p className="px-3 pt-2 pb-1 text-[9px] font-semibold text-text-muted uppercase tracking-widest">
            Appearance
          </p>
          <div className="flex flex-col p-1.5 pt-0.5 gap-0.5">
            {THEME_OPTS.map((opt) => {
              const Icon = opt.icon
              const active = theme === opt.id
              return (
                <button
                  key={opt.id}
                  onClick={() => setTheme(opt.id)}
                  data-testid={`theme-${opt.id}`}
                  className={cn(
                    'flex items-center gap-2.5 w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors',
                    active ? 'bg-cyan/10 text-cyan' : 'text-text-primary hover:bg-elevated',
                  )}
                >
                  <Icon size={13} className={active ? 'text-cyan' : 'text-text-muted'} />
                  <span className="flex-1">{opt.label}</span>
                  {active && <Check size={13} className="text-cyan" />}
                </button>
              )
            })}
          </div>

          <div className="border-t border-border" />
          <p className="px-3 pt-2 pb-1 text-[9px] font-semibold text-text-muted uppercase tracking-widest">
            Video model
          </p>
          <div className="flex flex-col p-1.5 pt-0.5 gap-0.5">
            {MODEL_OPTS.map((opt) => {
              const active = videoModel === opt.id
              return (
                <button
                  key={opt.id}
                  onClick={() => setVideoModel(opt.id)}
                  data-testid={`vidmodel-${opt.id}`}
                  title={`Up to ${opt.maxSecs}s per take · ${opt.refs} · max ${opt.maxRes}`}
                  className={cn(
                    'flex items-center gap-2.5 w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors',
                    active ? 'bg-cyan/10 text-cyan' : 'text-text-primary hover:bg-elevated',
                  )}
                >
                  <span className="font-semibold shrink-0">{opt.label}</span>
                  <span className="flex-1 text-[10px] text-text-muted truncate">{opt.note}</span>
                  {active && <Check size={13} className="text-cyan shrink-0" />}
                </button>
              )
            })}
          </div>
          {/* WARN, never block: the user owns the trade-off. 2.5 renders up to 1080p
              (live model list, 2026-09-04); 4K is base 2.0 only — say which one is being
              given up rather than silently downgrading a paid render. */}
          {resExceedsModel(outputResolution, videoModel) ? (
            <p className="mx-3 mb-2 mt-0.5 px-2 py-1.5 rounded-md bg-amber/10 border border-amber/30 text-[9px] text-amber leading-snug"
               data-testid="vidmodel-warning">
              {MODEL_OPTS.find((m) => m.id === videoModel)!.label} renders up to{' '}
              {MODEL_OPTS.find((m) => m.id === videoModel)!.maxRes} — the {outputResolution.toUpperCase()} output
              size below will not be reached. Switch to Seedance 2.0 for 4K, or keep 2.5 for
              30s takes and upscale afterwards.
            </p>
          ) : (
            <p className="px-3 pb-2 pt-0.5 text-[9px] text-text-dim leading-snug">
              Drives every shot render. 2.5 generates up to 30s in ONE take with a 50-material
              reference budget — longer takes and locked voices mean fewer continuity breaks.
            </p>
          )}

          <div className="border-t border-border" />
          <p className="px-3 pt-2 pb-1 text-[9px] font-semibold text-text-muted uppercase tracking-widest">
            Final output size
          </p>
          <div className="flex flex-col p-1.5 pt-0.5 gap-0.5">
            {RES_OPTS.map((opt) => {
              const active = outputResolution === opt.id
              return (
                <button
                  key={opt.id}
                  onClick={() => setOutputResolution(opt.id)}
                  data-testid={`outres-${opt.id}`}
                  className={cn(
                    'flex items-center gap-2.5 w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors',
                    active ? 'bg-cyan/10 text-cyan' : 'text-text-primary hover:bg-elevated',
                  )}
                >
                  <span className="font-semibold w-10 shrink-0">{opt.label}</span>
                  <span className="flex-1 text-[10px] text-text-muted truncate">{opt.note}</span>
                  {active && <Check size={13} className="text-cyan shrink-0" />}
                </button>
              )
            })}
          </div>
          <p className="px-3 pb-2 pt-0.5 text-[9px] text-text-dim leading-snug">
            Drives the final shot render + export. 4K is native 10-bit HEVC (Seedance 2.0 base).
          </p>

          <div className="border-t border-border" />
          <div className="p-1.5">
            <button
              onClick={() => { setUsageOpen(true); setOpen(false) }}
              data-testid="open-usage"
              className="flex items-center gap-2.5 w-full text-left px-2.5 py-1.5 rounded-md text-xs text-text-primary hover:bg-elevated transition-colors"
            >
              <BarChart3 size={13} className="text-text-muted" />
              <span className="flex-1">Usage &amp; cost</span>
            </button>
            <button
              onClick={() => { setErrorsOpen(true); setOpen(false) }}
              data-testid="open-error-log"
              className="flex items-center gap-2.5 w-full text-left px-2.5 py-1.5 rounded-md text-xs text-text-primary hover:bg-elevated transition-colors"
            >
              <ShieldAlert size={13} className="text-text-muted" />
              <span className="flex-1">Error log</span>
            </button>
          </div>
        </div>
      )}

      {usageOpen && <UsagePanel onClose={() => setUsageOpen(false)} />}
      {errorsOpen && <ErrorLogPanel onClose={() => setErrorsOpen(false)} />}
    </div>
  )
}
