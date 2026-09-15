'use client'

import { useState } from 'react'
import { ShieldCheck, Wand2, ChevronDown, ChevronUp, RefreshCw, CheckCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { QCResultBadge } from './QCResultBadge'
import { Button } from '@/components/ui/Button'
import type { QCResponse } from '@/lib/api/pipeline.api'

interface Props {
  qcResult: QCResponse
  isRunning?: boolean
  /** Called with director notes (auto-assembled or manually edited) to regenerate */
  onRegenerate: (notes: string) => void
  isRegenerating?: boolean
  /** Context label shown in the header, e.g. "Script", "Breakdown", "Shot S003" */
  context?: string
}

export function QCActionCard({
  qcResult,
  isRunning = false,
  onRegenerate,
  isRegenerating = false,
  context,
}: Props) {
  const [showNotes, setShowNotes] = useState(false)

  // Per-check editable notes, seeded from QC result
  const failedChecks = qcResult.checks.filter((c) => !c.passed)
  // The ones that mean "this cannot be built on", as opposed to "this is weaker than it
  // could be". Everything in this card used to paint the two the same colour.
  const blockingChecks = failedChecks.filter((c) => c.blocking)
  const [checkNotes, setCheckNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(failedChecks.map((c) => [c.label, c.notes ?? '']))
  )

  const allPassed = qcResult.passed

  /** One-click fix: send regen_prompt directly, no editing required */
  const handleAutoFix = () => {
    const notes = qcResult.regen_prompt ??
      failedChecks.map((c) => `• ${c.label}: ${c.notes ?? 'needs improvement'}`).join('\n')
    onRegenerate(notes)
  }

  /** Manual path: assemble edited per-check notes */
  const handleRegenWithNotes = () => {
    const assembled = failedChecks
      .map((c) => `• ${c.label}: ${checkNotes[c.label] ?? c.notes ?? ''}`)
      .filter((line) => line.trim().length > 3)
      .join('\n')
    onRegenerate(assembled)
  }

  return (
    <div className={cn(
      'rounded-lg border overflow-hidden transition-all',
      allPassed  ? 'border-green/40 bg-green/5'
      : isRunning ? 'border-cyan/30 bg-surface'
      : blockingChecks.length ? 'border-red/50 bg-red/5'
      :             'border-amber/40 bg-amber/5'
    )}>
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        {isRunning ? (
          <span className="w-3.5 h-3.5 border-2 border-cyan border-t-transparent rounded-full animate-spin shrink-0" />
        ) : allPassed ? (
          <CheckCircle size={13} className="text-green shrink-0" />
        ) : (
          <ShieldCheck size={13} className={cn('shrink-0',
            blockingChecks.length ? 'text-red' : 'text-amber')} />
        )}

        <div className="flex-1 min-w-0">
          <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
            {qcResult.persona ?? 'Claude QC'}
            {context ? ` — ${context}` : ''}
          </span>
          {isRunning && (
            <span className="text-[10px] text-cyan ml-2">Analysing…</span>
          )}
        </div>

        {/* "5 ISSUES" told the user his breakdown was broken five times over when not one
            of the five could stop anything: they were a long runtime, a missing shot
            size and three story observations. `blocking` is the flag that means the
            breakdown cannot be built on — it is what Autopilot stops for — so it is the
            one the badge counts. */}
        {!isRunning && (
          <span className={cn(
            'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border',
            allPassed ? 'text-green border-green/40 bg-green/10'
            : blockingChecks.length ? 'text-red border-red/40 bg-red/10'
            : 'text-amber border-amber/40 bg-amber/10'
          )} data-testid="qc-summary">
            {allPassed
              ? 'Passed'
              : blockingChecks.length
                ? `${blockingChecks.length} blocking · ${failedChecks.length - blockingChecks.length} note${failedChecks.length - blockingChecks.length === 1 ? '' : 's'}`
                : `nothing blocking · ${failedChecks.length} note${failedChecks.length > 1 ? 's' : ''}`}
          </span>
        )}
      </div>

      {/* ── WHY each failing check failed ──────────────────────────────────────
           The verdicts arrive with prose that names the offending ids and what to do
           about them ("Outside 4-15s — the API rejects these: SHOT_001, SHOT_012";
           "SC-001: 5 of 6 shots name no shot size"), and until now the card rendered a
           red word and threw the sentence away. It survived in exactly one place: inside
           the "Edit Notes" panel, as EDITABLE text — a regeneration input, presented to
           someone looking for a diagnosis. The user's report was "sólo veo el rojo, voy
           a ciegas", and he was right; you cannot argue with a verdict you cannot read.
           Blocking is marked apart from advisory for the same reason the story gates
           are: a note and a stop are not the same news. */}
      {!isRunning && failedChecks.length > 0 && (
        <div className="px-3 pb-2 flex flex-col gap-1.5 border-t border-border pt-2"
          data-testid="qc-failed-notes">
          {failedChecks.map((c) => (
            <div key={c.label} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className={cn('text-[10px] font-semibold',
                  c.blocking ? 'text-red' : 'text-amber')}>{c.label}</span>
                {c.blocking && (
                  <span className="text-[8px] font-bold uppercase tracking-wider px-1 py-px rounded border text-red border-red/40 bg-red/10">
                    blocking
                  </span>
                )}
              </div>
              {c.notes && (
                <p className="text-[10px] text-text-muted leading-relaxed">{c.notes}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── The full tally, AFTER the failures. 24 checks is an audit trail, not a
             headline: it belongs below the four sentences that say what to do. Capped
             and scrollable so the wall can never push the notes, the summary or the
             Approve button off the bottom of the card again. ── */}
      {!isRunning && (
        <div className="px-3 pb-2 pt-2 flex flex-wrap gap-1.5 items-center max-h-24 overflow-y-auto border-t border-border"
          data-testid="qc-check-badges">
          {qcResult.checks.map((c) => (
            <QCResultBadge key={c.label} label={c.label} passed={c.passed} />
          ))}
          {/* P4: style drift indicator */}
          {qcResult.drift_score != null && (
            <span className={cn(
              'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border font-mono',
              qcResult.drift_score < 0.25
                ? 'text-green border-green/40 bg-green/10'
                : qcResult.drift_score < 0.55
                  ? 'text-amber border-amber/40 bg-amber/10'
                  : 'text-red border-red/40 bg-red/10',
            )}>
              drift {Math.round(qcResult.drift_score * 100)}%
            </span>
          )}
        </div>
      )}

      {/* ── Summary + visual observations ── */}
      {!isRunning && (
        <div className="px-3 pb-2.5 text-[11px] text-text-muted leading-relaxed border-t border-border pt-2 space-y-1">
          <p>{qcResult.summary}</p>
          {qcResult.visual_observations && (
            <p className="text-[10px] text-text-dim">
              {[
                qcResult.visual_observations.render_style,
                qcResult.visual_observations.lighting,
                qcResult.visual_observations.dominant_palette,
              ].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      )}

      {/* ── Actions (only shown when there are failures) ── */}
      {!isRunning && !allPassed && (
        <div className="border-t border-border bg-elevated/40 px-3 py-2.5 flex flex-col gap-2">
          {/* Primary: Auto-Fix */}
          <div className="flex items-center gap-2">
            <Button
              variant="regenerate"
              size="sm"
              icon={<Wand2 size={12} />}
              loading={isRegenerating}
              onClick={handleAutoFix}
              className="flex-1"
            >
              Auto-Fix with Claude
            </Button>

            {/* Toggle: Edit Notes */}
            <button
              onClick={() => setShowNotes(!showNotes)}
              className={cn(
                'flex items-center gap-1 px-2 py-1.5 rounded text-[10px] font-semibold border transition-colors',
                showNotes
                  ? 'bg-cyan/10 text-cyan border-cyan/40'
                  : 'bg-border/50 text-text-muted border-border hover:border-cyan/30 hover:text-cyan'
              )}
            >
              Edit Notes
              {showNotes ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            </button>
          </div>

          {/* Expanded: per-check editable notes */}
          {showNotes && (
            <div className="flex flex-col gap-2 pt-1">
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">
                Edit fix notes for each failed check:
              </p>

              {failedChecks.map((check) => (
                <div key={check.label} className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold text-orange flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-orange shrink-0" />
                    {check.label}
                  </label>
                  <textarea
                    value={checkNotes[check.label] ?? ''}
                    onChange={(e) =>
                      setCheckNotes((prev) => ({ ...prev, [check.label]: e.target.value }))
                    }
                    rows={2}
                    placeholder={`Fix notes for ${check.label}…`}
                    className={cn(
                      'w-full bg-bg border border-border rounded px-2.5 py-1.5',
                      'text-xs text-text-primary placeholder:text-text-dim',
                      'focus:outline-none focus:border-orange/50 focus:ring-1 focus:ring-orange/20',
                      'resize-none transition-colors'
                    )}
                  />
                </div>
              ))}

              {/* Also show regen_prompt as a starting point if available */}
              {qcResult.regen_prompt && (
                <div className="text-[10px] text-text-muted bg-bg rounded p-2 border border-border italic">
                  <span className="font-semibold not-italic text-orange/80 block mb-0.5">
                    Claude suggested:
                  </span>
                  {qcResult.regen_prompt}
                </div>
              )}

              <Button
                variant="regenerate"
                size="sm"
                icon={<RefreshCw size={12} />}
                loading={isRegenerating}
                onClick={handleRegenWithNotes}
                className="w-full mt-1"
              >
                Regenerate with These Notes
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Thin skeleton shown while QC is running */
export function QCRunningCard({ context }: { context?: string }) {
  return (
    <div className="rounded-lg border border-cyan/30 bg-surface px-3 py-2.5 flex items-center gap-2">
      <span className="w-3.5 h-3.5 border-2 border-cyan border-t-transparent rounded-full animate-spin shrink-0" />
      <span className="text-[10px] text-cyan font-semibold uppercase tracking-widest">
        Claude QC{context ? ` — ${context}` : ''} running…
      </span>
    </div>
  )
}
