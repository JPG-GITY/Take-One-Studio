'use client'

/**
 * Per-project consumption panel (opened from Settings). Reads the metered totals
 * for the current project (localFolderRoot) from /api/project/usage — LLM/vision
 * token counts, image + video counts, video tokens by resolution, and an
 * ESTIMATED USD cost. Metering started when the feature shipped, so older
 * projects read back zeros until they generate something new.
 *
 * The cost figure is only over what has a DOCUMENTED rate. Images are priced by
 * model and pixel tier; anything else — an undocumented model, an image metered
 * before the breakdown existed — is excluded from the headline and named in the
 * amber block, count and all. It has to be visible: the previous panel priced
 * every image at one flat $0.03 and reported $22.95 for a BLOOM board that ran
 * entirely on a $0.09 tier.
 */

import { useState, useEffect, useCallback } from 'react'
import { X, Cpu, Eye, Image as ImageIcon, Film, DollarSign, RefreshCw, Loader2, AlertTriangle } from 'lucide-react'
import { usePipelineStore } from '@/store/pipeline.store'
import { apiClient } from '@/lib/api/client'

interface Bucket { calls: number; tokens_in: number; tokens_out: number }
interface ImageModel { count: number; refsBilled: number; byTier: Record<string, number> }
interface UsageData {
  llm: Bucket
  vision: Bucket
  images: { count: number; refsBilled?: number; byModel?: Record<string, ImageModel> }
  videos: { count: number; tokens: number; byResolution: Record<string, { count: number; tokens: number; byModel?: Record<string, { count: number; tokens: number }> }> }
  /* AI MediaKit masters (Stage 6). Optional: an older backend has no such bucket. */
  upscale?: { count: number; seconds: number; usd: number; byResolution: Record<string, { count: number; seconds: number; usd: number }> }
  estimatedCostUsd: number
  /* Present since images were priced per model + pixel tier. Optional so a response
     from an older backend still renders instead of throwing on `.unpricedImages`. */
  costBreakdown?: {
    llmUsd: number; imagesUsd: number; imageRefsUsd: number; videosUsd: number; upscaleUsd?: number
    unpricedImages: number; unpricedModels: string[]
  }
}

const fmt = (n: number) => n.toLocaleString('en-US')

export function UsagePanel({ onClose }: { onClose: () => void }) {
  const projectName = usePipelineStore((s) => s.projectName)
  const root = usePipelineStore((s) => s.localFolderRoot)
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!root) return
    setLoading(true); setError(null)
    try {
      const { data } = await apiClient.get<UsageData>('/api/project/usage', { params: { path: root } })
      setData(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage')
    } finally {
      setLoading(false)
    }
  }, [root])

  // Defer one microtask so the loading flag isn't a synchronous setState in the effect.
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  const llmTokens = data ? data.llm.tokens_in + data.llm.tokens_out + data.vision.tokens_in + data.vision.tokens_out : 0

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" data-testid="usage-panel">
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[520px] max-w-[92vw] max-h-[85vh] overflow-y-auto bg-surface border border-border rounded-xl shadow-[0_12px_48px_rgba(0,0,0,0.5)]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border sticky top-0 bg-surface">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Project usage</h2>
            <p className="text-[10px] text-text-muted truncate max-w-[360px]">{projectName} · {root ?? 'no project folder'}</p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={load} title="Refresh" className="p-1.5 rounded text-text-muted hover:text-cyan hover:bg-elevated transition-colors">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
            <button onClick={onClose} data-testid="usage-close" className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-elevated transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="p-5">
          {!root ? (
            <p className="text-xs text-text-muted py-8 text-center">Open or create a project to track its usage.</p>
          ) : error ? (
            <p className="text-xs text-red py-8 text-center">{error}</p>
          ) : !data ? (
            <p className="text-xs text-text-muted py-8 text-center"><Loader2 size={14} className="inline animate-spin mr-1" /> loading…</p>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Estimated cost — headline */}
              <div className="rounded-lg border border-cyan/30 bg-cyan/5 p-4 flex items-center gap-3">
                <DollarSign size={20} className="text-cyan" />
                <div>
                  <p className="text-2xl font-bold text-text-primary leading-none">${data.estimatedCostUsd.toFixed(2)}</p>
                  <p className="text-[10px] text-text-muted mt-1">Estimated spend (not a billing figure)</p>
                </div>
              </div>

              {/* WHAT THE HEADLINE DOES NOT COVER. The figure above used to include every
                  image at one invented flat rate; images are now priced by model and pixel
                  tier, and anything whose rate is not documented is EXCLUDED. Excluding it
                  silently would be the same defect as guessing it, so the count and the
                  models are named here, next to the number they are missing from. */}
              {(data.costBreakdown?.unpricedImages ?? 0) > 0 && (
                <div className="rounded-lg border border-amber/30 bg-amber/5 p-3 flex gap-2"
                  data-testid="usage-unpriced">
                  <AlertTriangle size={14} className="text-amber shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-[11px] text-text-primary">
                      <span className="font-semibold">{fmt(data.costBreakdown!.unpricedImages)} image
                      {data.costBreakdown!.unpricedImages !== 1 ? 's' : ''}</span> are NOT in the figure
                      above — no published price for what produced them.
                    </p>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {data.costBreakdown!.unpricedModels.map((m) => (
                        <li key={m} className="text-[10px] text-text-muted font-mono truncate">{m} · rate unknown</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Where the priced part came from. */}
              {data.costBreakdown && (
                <div className="rounded-lg border border-border bg-elevated/40 p-3" data-testid="usage-breakdown">
                  <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-2">Cost breakdown</p>
                  <div className="flex flex-col gap-1">
                    {([['LLM / vision tokens', data.costBreakdown.llmUsd],
                       ['Images', data.costBreakdown.imagesUsd],
                       ['Input reference images', data.costBreakdown.imageRefsUsd],
                       ['Videos', data.costBreakdown.videosUsd]] as [string, number][]).map(([label, usd]) => (
                      <div key={label} className="flex justify-between text-[11px]">
                        <span className="text-text-primary">{label}</span>
                        <span className="text-text-muted font-mono">${usd.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Images by model + pixel tier — the two things the price actually depends on. */}
              {Object.keys(data.images.byModel ?? {}).length > 0 && (
                <div className="rounded-lg border border-border bg-elevated/40 p-3" data-testid="usage-images-by-model">
                  <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-2">Images by model</p>
                  <div className="flex flex-col gap-1">
                    {Object.entries(data.images.byModel ?? {}).sort().map(([mdl, b]) => (
                      <div key={mdl} className="flex justify-between gap-2 text-[11px]">
                        <span className="text-text-primary font-mono truncate">{mdl}</span>
                        <span className="text-text-muted whitespace-nowrap">
                          {Object.entries(b.byTier).sort().map(([t, n]) => `${n} @ ${t}`).join(' · ')}
                          {b.refsBilled > 0 ? ` · ${b.refsBilled} ref` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Metric cards */}
              <div className="grid grid-cols-2 gap-3">
                <Metric icon={Cpu} label="LLM calls" value={fmt(data.llm.calls)}
                  sub={`${fmt(data.llm.tokens_in)} in · ${fmt(data.llm.tokens_out)} out`} />
                <Metric icon={Eye} label="Vision / aux" value={fmt(data.vision.calls)}
                  sub={`${fmt(data.vision.tokens_in)} in · ${fmt(data.vision.tokens_out)} out`} />
                {/* The sub-line used to read a hard-coded "Seedream 5.0" for every image,
                    which is the same assumption that made the flat per-image price look
                    reasonable — the environment angle sheets run a different Seedream. It
                    now reports the input references, which are a real billed line item. */}
                <Metric icon={ImageIcon} label="Images" value={fmt(data.images.count)}
                  sub={`${fmt(data.images.refsBilled ?? 0)} billed input ref${(data.images.refsBilled ?? 0) === 1 ? '' : 's'}`} />
                <Metric icon={Film} label="Videos" value={fmt(data.videos.count)}
                  sub={`${fmt(data.videos.tokens)} tokens`} />
                {/* Masters are priced at record time from the vendor's coefficient table, so
                    this is what was quoted and paid — not an estimate like the rest. */}
                {(data.upscale?.count ?? 0) > 0 && (
                  <Metric icon={Film} label="Upscales" value={fmt(data.upscale!.count)}
                    sub={`${data.upscale!.seconds.toFixed(0)}s · $${data.upscale!.usd.toFixed(2)}`} />
                )}
              </div>

              {/* Video by resolution */}
              {Object.keys(data.videos.byResolution).length > 0 && (
                <div className="rounded-lg border border-border bg-elevated/40 p-3">
                  <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-2">Videos by resolution</p>
                  <div className="flex flex-col gap-1">
                    {Object.entries(data.videos.byResolution).sort().map(([res, b]) => (
                      <div key={res} className="flex justify-between text-[11px]">
                        <span className="text-text-primary font-mono">{res || '—'}</span>
                        <span className="text-text-muted">{b.count} clip{b.count !== 1 ? 's' : ''} · {fmt(b.tokens)} tokens</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[10px] text-text-dim leading-snug">
                {llmTokens === 0 && data.images.count === 0 && data.videos.count === 0
                  ? 'No usage recorded yet for this project. Metering counts from now on (older work isn’t retroactive).'
                  : 'Tokens are real (from the model responses); cost is an estimate from public price tables.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Metric({ icon: Icon, label, value, sub }: { icon: React.ElementType; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-border bg-elevated/40 p-3">
      <div className="flex items-center gap-1.5 text-text-muted">
        <Icon size={12} />
        <span className="text-[10px] font-semibold uppercase tracking-widest">{label}</span>
      </div>
      <p className="text-xl font-bold text-text-primary mt-1">{value}</p>
      <p className="text-[10px] text-text-muted truncate">{sub}</p>
    </div>
  )
}
