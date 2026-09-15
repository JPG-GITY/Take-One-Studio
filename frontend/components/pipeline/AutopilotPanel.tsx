'use client'

/** P5c.1: Autopilot entry — a concept box that kicks off the auto-draft
 * (script → breakdown). The actual run is driven by AutopilotController. */

import { useState } from 'react'
import { Rocket, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePipelineStore } from '@/store/pipeline.store'
import { forecastProjectCost, fmtCost } from '@/lib/costForecast'

export function AutopilotPanel() {
  const { autopilot, startAutopilot, stopAutopilot, targetDurationSecs, outputResolution, videoModel } = usePipelineStore()
  const [open, setOpen] = useState(false)
  const [concept, setConcept] = useState('')
  const forecast = forecastProjectCost(targetDurationSecs, outputResolution, videoModel)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        data-testid="autopilot-button"
        title="Autopilot — draft script + breakdown from a concept"
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold rounded border transition-all mr-1',
          autopilot.running
            ? 'text-cyan border-cyan/50 bg-cyan/10'
            : 'text-text-muted border-border hover:text-cyan hover:border-cyan/30',
        )}
      >
        <Rocket size={11} />
        Autopilot{autopilot.running ? '…' : ''}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 w-72 bg-surface border border-border rounded-lg shadow-lg z-50 p-3 flex flex-col gap-2"
          data-testid="autopilot-panel"
        >
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-widest text-cyan flex items-center gap-1">
              <Rocket size={11} /> Autopilot
            </p>
            <button onClick={() => setOpen(false)} className="text-text-muted hover:text-text-primary">
              <X size={12} />
            </button>
          </div>
          <p className="text-[10px] text-text-muted leading-relaxed">
            Describe your film — Autopilot writes the script and the asset/shot breakdown, then drops you at Stage 3 to review assets.
          </p>
          <textarea
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
            placeholder="e.g. A neon-noir detective hunts a rogue AI in a flooded megacity…"
            rows={3}
            data-testid="autopilot-concept"
            disabled={autopilot.running}
            className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/50 resize-none"
          />
          {autopilot.running ? (
            <>
              <div className="flex items-center gap-2 text-[10px] text-cyan">
                <span className="w-3 h-3 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
                {autopilot.phase || 'Running…'}
              </div>
              <button
                onClick={stopAutopilot}
                data-testid="autopilot-stop"
                className="w-full py-1.5 rounded border border-red/40 text-red text-[11px] font-semibold hover:bg-red/10 transition-colors"
              >
                Stop
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between rounded border border-border bg-elevated/40 px-2 py-1.5" data-testid="autopilot-forecast">
                <span className="text-[10px] text-text-muted">
                  Est. ≈{forecast.shots} shots · {outputResolution}
                </span>
                <span className="text-[11px] font-bold text-cyan">~{fmtCost(forecast.costUsd)}</span>
              </div>
              <button
                onClick={() => { const c = concept.trim(); if (c) startAutopilot(c) }}
                disabled={!concept.trim()}
                data-testid="autopilot-start"
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-cyan/15 border border-cyan/40 text-cyan text-[11px] font-semibold hover:bg-cyan/25 disabled:opacity-40 disabled:cursor-default transition-colors"
              >
                <Rocket size={12} /> Start autopilot
              </button>
            </>
          )}
          {autopilot.error && <p className="text-[10px] text-red leading-relaxed">{autopilot.error}</p>}
        </div>
      )}
    </div>
  )
}
