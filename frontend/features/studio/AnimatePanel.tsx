'use client'

import { useState, useCallback } from 'react'
import { X, Sparkles, Wand2, Loader2, ScanEye } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiClient } from '@/lib/api/client'

const MIN_SECS = 4
const RESOLUTIONS = ['480p', '720p', '1080p', '4k'] as const
/** Ceilings from the live ModelArk model list (read 2026-09-04): base 2.0 renders up to
 *  4k, 2.5 up to 1080p (10-bit), Fast and Mini stop at 720p. Clip length is per-model
 *  too: 15 s on the 2.0 family, 30 s on 2.5. The picker filters both rather than letting
 *  the backend reject the render. */
const TIERS = [
  { id: 'base' as const, label: 'Seedance 2.0', hint: 'up to 4K · 15s', max: '4k', maxSecs: 15 },
  { id: 'fast' as const, label: 'Fast', hint: 'up to 720p · 15s', max: '720p', maxSecs: 15 },
  { id: 'mini' as const, label: 'Mini', hint: 'up to 720p · 15s', max: '720p', maxSecs: 15 },
  { id: 'v25' as const, label: '2.5', hint: 'up to 1080p · 30s', max: '1080p', maxSecs: 30 },
]
export type AnimateTier = typeof TIERS[number]['id']
const tierOf = (t: string) => TIERS.find((x) => x.id === t) ?? TIERS[0]
const resolutionsFor = (t: string) =>
  RESOLUTIONS.slice(0, RESOLUTIONS.indexOf(tierOf(t).max as typeof RESOLUTIONS[number]) + 1)
const maxSecsFor = (t: string) => tierOf(t).maxSecs

interface Props {
  /** The still to animate — a DISK path when we have one (the backend reads it
   *  byte-exact, no HTTP round-trip), else its url. */
  image: string
  /** Shown in the header so it is obvious which generation is being animated. */
  title: string
  onClose: () => void
  onGenerate: (opts: { prompt: string; duration: number; resolution: string; genAudio: boolean; tier: AnimateTier }) => void
}

/**
 * "Animate" — turn a Studio still into a Seedance clip without leaving the card.
 *
 * The prompt starts EMPTY on purpose: in image-to-video the model already has the frame,
 * so the prompt has to carry the MOTION (what changes, how the camera moves, the pacing).
 * Re-describing the picture wastes it. "Analyze image" reads the still and proposes
 * exactly that motion; Enhance then tightens it.
 */
export function AnimatePanel({ image, title, onClose, onGenerate }: Props) {
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState(5)
  const [resolution, setResolution] = useState<string>('720p')
  const [tier, setTier] = useState<AnimateTier>('base')
  // OFF by default — same reason as the composer's toggle in StudioView: asking Seedance
  // to invent a soundtrack for a still that carries no audio direction is what trips its
  // copyright filter and kills the render.
  const [genAudio, setGenAudio] = useState(false)
  const [busy, setBusy] = useState<'' | 'analyze' | 'enhance'>('')
  const [error, setError] = useState<string | null>(null)

  const analyze = useCallback(async () => {
    setBusy('analyze'); setError(null)
    try {
      // The current text (if any) rides along as the director's intent.
      const { data } = await apiClient.post<{ prompt?: string }>(
        '/api/studio/motion-prompt', { image, hint: prompt.trim() }, { timeout: 120_000 },
      )
      if (data.prompt) setPrompt(data.prompt)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the image')
    } finally { setBusy('') }
  }, [image, prompt])

  const enhance = useCallback(async () => {
    if (!prompt.trim()) { setError('Write or analyze a motion first.'); return }
    setBusy('enhance'); setError(null)
    try {
      const { data } = await apiClient.post<{ prompt?: string }>(
        '/api/studio/enhance-prompt', { prompt: prompt.trim(), mode: 'video' }, { timeout: 90_000 },
      )
      if (data.prompt) setPrompt(data.prompt)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enhance failed')
    } finally { setBusy('') }
  }, [prompt])

  return (
    <>
      <div className="fixed inset-0 z-40 bg-bg/80" onClick={onClose} />
      <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] rounded-xl border border-border bg-surface shadow-2xl"
        data-testid="animate-panel">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Sparkles size={14} className="text-cyan" />
          <p className="text-[12px] font-semibold text-text-primary flex-1 truncate">Animate · {title}</p>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={15} /></button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest flex-1">Motion</span>
            <button onClick={() => void analyze()} disabled={!!busy} data-testid="animate-analyze"
              title="Read the image and propose the motion that fits it"
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-cyan/40 bg-cyan/5 text-[10px] font-semibold text-cyan hover:bg-cyan/15 disabled:opacity-40">
              {busy === 'analyze' ? <Loader2 size={11} className="animate-spin" /> : <ScanEye size={11} />}
              Analyze image
            </button>
            <button onClick={() => void enhance()} disabled={!!busy || !prompt.trim()} data-testid="animate-enhance"
              title="Tighten this motion direction for Seedance"
              className="flex items-center gap-1 text-[10px] text-text-muted hover:text-cyan disabled:opacity-40">
              {busy === 'enhance' ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}Enhance
            </button>
          </div>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4}
            data-testid="animate-prompt"
            placeholder="What MOVES — e.g. she turns toward the window as the camera pushes slowly in, light shifting warmer"
            className="w-full px-2 py-1.5 rounded bg-elevated border border-border text-[11px] text-text-primary placeholder:text-text-dim outline-none focus:border-cyan/50 resize-none" />
          <p className="text-[9px] text-text-dim leading-relaxed">
            Seedance already has this frame — describe what CHANGES, not what is in it.
          </p>

          <div className="flex items-center gap-3 flex-wrap border-t border-border pt-3">
            <label className="flex items-center gap-2 text-[11px] text-text-muted">
              Duration
              <input type="range" min={MIN_SECS} max={maxSecsFor(tier)} value={duration}
                onChange={(e) => setDuration(Number(e.target.value))} data-testid="animate-duration"
                className="w-28 accent-cyan" />
              <span className="font-mono text-text-primary w-8">{duration}s</span>
            </label>
            <div className="flex items-center rounded-lg border border-border overflow-hidden">
              {TIERS.map((t) => (
                <button key={t.id} data-testid={`animate-tier-${t.id}`} title={`${t.label} — ${t.hint}`}
                  onClick={() => {
                    setTier(t.id)
                    // Downgrade rather than keep an impossible pick selected — for BOTH
                    // ceilings, since 2.5 allows 30 s and the 2.0 family stops at 15 s.
                    if (!resolutionsFor(t.id).includes(resolution as typeof RESOLUTIONS[number])) setResolution(t.max)
                    if (duration > t.maxSecs) setDuration(t.maxSecs)
                  }}
                  className={cn('px-2 py-1 text-[10px] transition-colors',
                    tier === t.id ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:text-text-primary')}
                >{t.label}</button>
              ))}
            </div>
            <div className="flex items-center rounded-lg border border-border overflow-hidden">
              {resolutionsFor(tier).map((r) => (
                <button key={r} onClick={() => setResolution(r)} data-testid={`animate-res-${r}`}
                  className={cn('px-2 py-1 text-[10px] font-mono transition-colors',
                    resolution === r ? 'bg-cyan/15 text-cyan' : 'text-text-muted hover:text-text-primary')}
                >{r}</button>
              ))}
            </div>
            <button onClick={() => setGenAudio((v) => !v)} data-testid="animate-audio"
              className={cn('flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px]',
                genAudio ? 'border-cyan/40 bg-cyan/5 text-cyan' : 'border-border text-text-muted')}
            >Audio {genAudio ? 'on' : 'off'}</button>
          </div>

          {error && <p className="text-[11px] text-red">{error}</p>}

          <div className="flex items-center gap-2 border-t border-border pt-3">
            <button onClick={onClose}
              className="px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-text-primary">Cancel</button>
            <button
              onClick={() => { onGenerate({ prompt: prompt.trim(), duration, resolution, genAudio, tier }); onClose() }}
              disabled={!prompt.trim() || !!busy}
              data-testid="animate-generate"
              className="ml-auto flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-cyan text-bg text-[11px] font-semibold hover:bg-cyan/90 disabled:opacity-50 disabled:bg-elevated disabled:text-text-dim"
            ><Sparkles size={12} />Animate</button>
          </div>
        </div>
      </div>
    </>
  )
}
