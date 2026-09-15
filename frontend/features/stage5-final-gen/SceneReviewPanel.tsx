'use client'

import { useState } from 'react'
import { ChevronUp, ChevronDown, Cpu, Sparkles, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentsStore } from '@/store/agents.store'
import { usePipelineStore } from '@/store/pipeline.store'
import { ApprovalControls } from '@/components/pipeline/ApprovalControls'
import { EnhanceButton } from '@/components/pipeline/EnhanceButton'
import { QCResultBadge } from '@/components/agent/QCResultBadge'
import { ReferenceMediaPanel, type ReferenceMedia } from '@/components/media/ReferenceMediaPanel'
import { ReferencesSent } from '@/components/media/ReferencesSent'
import type { GeneratedShot, ShotVersion } from '@/lib/types/pipeline.types'
import type { QCResponse } from '@/lib/api/pipeline.api'

interface Props {
  shot: GeneratedShot | null
  qcResult: QCResponse | null
  refMedia: ReferenceMedia
  onRefMediaChange: (rm: ReferenceMedia) => void
  onApprove: () => void
  /** Re-render this shot. ONLY reachable from the "storyboard changed" banner now —
   *  the standalone Re-take button was removed (2026-07-27) because a fresh Stage-5
   *  take swaps the clip's media under Stage 6's timeline. Normal re-generation goes
   *  through onDirect / onRegenerate. */
  onRetake?: () => void
  onRenderHD?: () => void         // P3.12: re-render an approved draft at the final output size
  /** P4: switch this shot into (or out of) motion-reference mode so an attached
   *  reference video actually drives the motion. */
  onSetMotionRef?: (on: boolean) => void
  /** Continuity mode: open this shot on the previous shot's closing frame.
   *  Mutually exclusive with the reference-image modes (see GeneratedShot.mode). */
  onSetContinuity?: (on: boolean) => void
  hasStoryboard?: boolean
  /** Las referencias que la etapa DERIVÓ para este plano, en el orden en que se envían.
   *  Se muestran siempre: hasta ahora el usuario no tenía forma de saber qué se adjuntaba
   *  a un render que estaba a punto de pagar, y el recorte al tope del modelo descartaba
   *  en silencio. Ver `refCap`. */
  autoRefs?: Array<{ url: string; label: string }>
  /** El tope de imágenes del modelo elegido. Cuando `autoRefs` lo pasa, las que sobran no
   *  se envían — y eso hay que decirlo antes del gasto, no después. */
  refCap?: number
  /** The derived references the director took out of this shot, and the two controls.
   *  See `ReferencesSent`; the decision lives in the store (`shotRefMedia[].excluded`). */
  excludedRefs?: Array<{ url: string; label: string; key?: string }>
  onExcludeRef?: (ref: { url: string; label: string; key?: string }) => void
  onRestoreRef?: (ref: { url: string; label: string; key?: string }) => void
  /** The project's approved assets, for the panel's "From project" source. */
  projectAssets?: Array<{ id: string; name: string; type: string; url: string }>
  /** Item 7d: per-shot director notes, honored by the animation prompt. */
  onNotesChange?: (notes: string) => void
  /** P5a Magic Box: a natural-language directing instruction for this shot. */
  onDirect?: (instruction: string) => void
  /** Item 8: reopen an approved shot (the approval trap fix). */
  onUnapprove?: () => void
  onRegenerate: (feedback: string) => void
  /** 3-bug1c: the storyboard board advanced past the version this clip was rendered from. */
  boardStale?: boolean
  /** El board no describe este corte: sus anotaciones de cámara se DESCARTARON y el
   *  prompt se armó sólo con la lista de planos. Persistente y con acción, no un toast:
   *  el aviso que se va solo es el que nadie ve — este equipo lo tuvo delante toda una
   *  tarde sin verlo. `summary` viene del backend y ya dice qué hacer. */
  boardMismatch?: string
  /** Llevar al usuario a la etapa 4 a re-boardear la tarjeta. */
  onGoToBoard?: () => void
  /** Item 4F: per-shot take history + switcher. */
  takes?: ShotVersion[]
  selectedTakeId?: string
  onSelectTake?: (versionId: string) => void
  isGenerating: boolean
}

function QCAgentCard({ qcResult }: { qcResult: QCResponse | null }) {
  const [expanded, setExpanded] = useState(true)
  const qcAgent = useAgentsStore((s) => s.agents.qc)

  const isRunning = qcAgent.status === 'active'
  const hasResult = !!qcResult

  return (
    <div className={cn(
      'rounded-lg border overflow-hidden transition-colors',
      isRunning
        ? 'border-orange/50 bg-orange/5'
        : hasResult && qcResult?.passed
          ? 'border-green/30 bg-green/5'
          : hasResult
            ? 'border-red/30 bg-red/5'
            : 'border-border bg-elevated'
    )}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-text-primary/[0.04] transition-colors"
      >
        <div className={cn(
          'w-7 h-7 rounded-full border-2 flex items-center justify-center shrink-0',
          isRunning
            ? 'border-orange/60 bg-orange/10 text-orange'
            : hasResult && qcResult?.passed
              ? 'border-green/60 bg-green/10 text-green'
              : hasResult
                ? 'border-red/60 bg-red/10 text-red'
                : 'border-border bg-border/40 text-text-muted'
        )}>
          <Cpu size={12} />
        </div>

        <div className="flex-1 text-left">
          <p className="text-[11px] font-semibold text-text-primary">Take One QC Agent</p>
          <p className={cn('text-[9px] font-semibold uppercase tracking-wider',
            isRunning ? 'text-orange' : hasResult && qcResult?.passed ? 'text-green' : hasResult ? 'text-red' : 'text-text-muted'
          )}>
            {isRunning ? 'Running…' : hasResult ? `(Final Review): ${qcResult!.passed ? 'PASSED' : 'ISSUES FOUND'}` : 'Awaiting generation'}
          </p>
        </div>

        {expanded ? <ChevronUp size={12} className="text-text-muted" /> : <ChevronDown size={12} className="text-text-muted" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          {isRunning && !hasResult && (
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 border-2 border-orange border-t-transparent rounded-full animate-spin" />
              <span className="text-[11px] text-orange">{qcAgent.detail}</span>
            </div>
          )}

          {hasResult && (
            <>
              <div className="flex items-center gap-2">
                <span className={cn('w-2 h-2 rounded-full', qcResult!.passed ? 'bg-green' : 'bg-red animate-pulse')} />
                <span className={cn('text-[11px] font-bold uppercase tracking-wider', qcResult!.passed ? 'text-green' : 'text-red')}>
                  Scene Analysis: {qcResult!.passed ? 'Completed' : 'Issues Found'}
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {qcResult!.checks.map(({ label, passed }) => (
                  <QCResultBadge key={label} label={label} passed={passed} />
                ))}
              </div>

              <div className="text-[10px] text-text-muted leading-relaxed pt-1.5 border-t border-border">
                {qcResult!.summary}
              </div>

              {qcResult!.regen_prompt && (
                <div className="text-[10px] text-orange italic border-t border-border pt-1.5">
                  <span className="font-semibold not-italic text-orange/80">Suggested fix: </span>
                  {qcResult!.regen_prompt}
                </div>
              )}
            </>
          )}

          {!isRunning && !hasResult && (
            <p className="text-[10px] text-text-muted">
              The Take One QC agent reviews this shot automatically after generation.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function SceneReviewPanel({ shot, qcResult, refMedia, onRefMediaChange, onApprove, onNotesChange, onDirect, onUnapprove, onRegenerate, onRetake, boardStale, boardMismatch, onGoToBoard, takes = [], selectedTakeId, onSelectTake, isGenerating, onSetContinuity, onSetMotionRef, autoRefs = [], excludedRefs, onExcludeRef, onRestoreRef, projectAssets, refCap }: Props) {
  const [tab, setTab] = useState<'review' | 'status'>('review')
  const [feedback, setFeedback] = useState('')
  const [directText, setDirectText] = useState('')
  const { stages } = usePipelineStore()
  const stage5 = stages[5]

  const canApprove = !!shot && shot.status !== 'approved' && !isGenerating

  return (
    <aside className="w-[280px] shrink-0 flex flex-col bg-surface rounded-lg border border-border overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        {(['review', 'status'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'flex-1 py-2.5 text-[10px] font-bold tracking-widest uppercase transition-colors',
              tab === t
                ? 'text-cyan border-b-2 border-cyan bg-cyan/5'
                : 'text-text-muted hover:text-text-primary'
            )}
          >
            {t === 'review' ? 'Review & Feedback' : 'Status'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
        {tab === 'review' && (
          <>
            {/* 3-bug1c: board regenerated after this clip rendered — offer a per-shot
                re-render (mark-stale, never auto-reset). Reuses the existing onRetake. */}
            {boardMismatch && (
              <section className="flex items-center gap-2 px-2 py-1.5 rounded border border-red/50 bg-red/10 text-red"
                data-testid="board-mismatch-banner">
                <AlertTriangle size={12} className="shrink-0" />
                <span className="text-[10px] leading-snug flex-1">
                  This board describes a different cut, so its camera annotations were
                  dropped — the prompt was built from the shot list alone. {boardMismatch}
                </span>
                {onGoToBoard && (
                  <button onClick={() => onGoToBoard()}
                    data-testid="mismatch-go-to-board"
                    className="shrink-0 px-2 py-0.5 rounded border border-red/50 text-[10px] font-semibold hover:bg-red/15 transition-colors">
                    Re-board it
                  </button>
                )}
              </section>
            )}
            {shot?.videoUrl && boardStale && (
              <section className="flex items-center gap-2 px-2 py-1.5 rounded border border-orange/40 bg-orange/10 text-orange"
                data-testid="board-stale-banner">
                <AlertTriangle size={12} className="shrink-0" />
                <span className="text-[10px] leading-snug flex-1">
                  Storyboard changed after this clip was rendered — nothing was deleted. Regenerate to sync.
                </span>
                {onRetake && (
                  <button
                    onClick={() => onRetake()}
                    disabled={isGenerating}
                    data-testid="regen-stale-clip"
                    className="shrink-0 px-2 py-0.5 rounded border border-orange/50 text-[10px] font-semibold hover:bg-orange/15 disabled:opacity-50 transition-colors"
                  >
                    Regenerate this clip
                  </button>
                )}
              </section>
            )}

            {/* Reference media + motion-reference removed from Stage 5: identity now
                rides on the per-character Face Anchor, and the panel did nothing
                visible here (it confused more than it helped). */}

            {/* P5a Magic Box: direct this shot in natural language */}
            {shot && onDirect && shot.status !== 'animating' && shot.status !== 'generating' && (
              <section className="border-t border-border pt-3">
                <p className="text-[10px] font-semibold text-cyan uppercase tracking-widest mb-1.5 flex items-center gap-1">
                  <Sparkles size={11} /> Direct this shot
                  <EnhanceButton className="ml-auto" value={directText} onEnhanced={setDirectText}
                    field="natural-language direction for a video shot" />
                </p>
                <textarea
                  value={directText}
                  onChange={(e) => setDirectText(e.target.value)}
                  placeholder={'e.g. "slower, push in at dusk, she looks scared"'}
                  rows={2}
                  data-testid="direct-input"
                  disabled={isGenerating}
                  className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/50 resize-none"
                />
                <button
                  type="button"
                  onClick={() => { const t = directText.trim(); if (t) { onDirect(t); setDirectText('') } }}
                  disabled={isGenerating || !directText.trim()}
                  data-testid="direct-apply"
                  className="mt-1.5 w-full flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg bg-cyan/15 border border-cyan/40 text-cyan text-[11px] font-semibold hover:bg-cyan/25 disabled:opacity-40 disabled:cursor-default transition-colors"
                >
                  <Sparkles size={12} /> Apply direction
                </button>
                <p className="text-[9px] text-text-dim mt-1 leading-relaxed">
                  Claude refines it against this shot and regenerates only this shot (re-animates for motion/mood, re-keyframes for framing).
                </p>
              </section>
            )}

            {/* Item 7d: per-shot director notes — honored at generation time */}
            {shot && onNotesChange && !shot.videoUrl && (
              <section className="border-t border-border pt-3">
                <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1.5 flex items-center gap-1">
                  Shot Notes <span className="normal-case font-normal text-text-dim">(used in generation)</span>
                  <EnhanceButton className="ml-auto" value={shot.notes ?? ''} onEnhanced={onNotesChange}
                    field="director note for a video shot" />
                </p>
                <textarea
                  value={shot.notes ?? ''}
                  onChange={(e) => onNotesChange(e.target.value)}
                  placeholder="e.g. the detective should be looking at the body; only one body on the ground"
                  rows={2}
                  data-testid="shot-notes"
                  className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-orange/50 resize-none"
                />
              </section>
            )}

            {/* Continuity: pin this shot's first frame to the previous shot's last.
                Stated as the trade it is — Seedance cannot take a first frame AND
                reference images, so turning this on drops the character sheets for
                this shot. Worth it across a continuous action cut, wrong when the
                shot needs the sheets to hold the face. */}
            {/* QUÉ SE ADJUNTA A ESTE RENDER, Y LA POSIBILIDAD DE CAMBIARLO.
                Hasta ahora la etapa derivaba las referencias sola, las recortaba en
                silencio al tope del modelo y las enviaba sin enseñárselas a nadie: el
                usuario pagaba un render sin saber qué llevaba. Estas dos props existían
                y llegaban aquí desde hace tiempo, pero la firma del componente no las
                desestructuraba, así que se caían al suelo — y con ellas el modo de
                referencia de movimiento entero, que quedaba inalcanzable desde la UI.
                Se muestra SIEMPRE, no detrás de un interruptor: componer antes de generar
                es el trabajo, no una opción avanzada. */}
            {shot && (
              <section className="border-t border-border pt-3 flex flex-col gap-2"
                       data-testid="shot-references">
                <ReferencesSent refs={autoRefs} cap={refCap} testId="shot-refs"
                  excluded={excludedRefs} onExclude={onExcludeRef} onRestore={onRestoreRef} />
                {/* Open by default and named by what it DOES: the two ways to add a reference
                    were behind a collapsed header that said "Reference Media", and the
                    director read it as a label, not a control. */}
                <ReferenceMediaPanel
                  value={refMedia}
                  onChange={onRefMediaChange}
                  maxImages={4}
                  disabled={isGenerating}
                  defaultOpen
                  headerLabel="Add a reference · upload, URL or project"
                  defaultRole="reference_image"
                  projectAssets={projectAssets}
                />
                {onSetMotionRef && (
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={shot.mode === 'motion_ref'}
                      onChange={(e) => onSetMotionRef(e.target.checked)}
                      disabled={isGenerating || !refMedia.videos.length}
                      data-testid="motion-ref-toggle"
                      className="mt-0.5 accent-cyan"
                    />
                    <span className="text-[11px] leading-snug">
                      <span className="font-semibold text-text-primary">Drive the motion from a video</span>
                      <span className="block text-text-dim">
                        {refMedia.videos.length
                          ? 'Takes movement and timing from the attached clip, not its people or place.'
                          : 'Attach a reference video above to enable this.'}
                      </span>
                    </span>
                  </label>
                )}
              </section>
            )}
            {onSetContinuity && shot && (
              <section className="border-t border-border pt-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shot.mode === 'continuity'}
                    onChange={(e) => onSetContinuity(e.target.checked)}
                    disabled={isGenerating}
                    data-testid="continuity-toggle"
                    className="mt-0.5 accent-cyan"
                  />
                  <span className="text-[11px] leading-snug">
                    <span className="font-semibold text-text-primary">Match the previous cut</span>
                    <span className="block text-text-dim">
                      Opens on the previous shot&apos;s last frame for an exact match.
                      Drops this shot&apos;s character references — Seedance takes one or
                      the other, never both.
                    </span>
                  </span>
                </label>
              </section>
            )}

            {/* Item 8: reopen an approved shot — no more approval trap */}
            {shot?.status === 'approved' && onUnapprove && (
              <section className="border-t border-border pt-3">
                <button
                  onClick={onUnapprove}
                  data-testid="unapprove-shot"
                  className="w-full py-2 px-3 rounded-lg border border-red/40 bg-red/10 text-red text-[11px] font-semibold hover:bg-red/20 transition-colors"
                >
                  Un-approve / Reopen Shot
                </button>
                {!shot.videoUrl && (
                  <p className="text-[9px] text-amber mt-1">This shot was approved without a rendered video.</p>
                )}
              </section>
            )}

            {/* Item 4F: switch between previously-rendered takes (each finished render
                is a take; disk keeps them as video_vNNN.mp4 — including Stage-6 re-takes
                and edits, which register into this same shared history). Single-take
                shots show nothing here.
                The "Re-render (new take)" BUTTON was removed (2026-07-27): a fresh
                Stage-5 take changes the shot's videoLocalPath, and Stage 6 then swaps
                that clip's media underneath the timeline (DeliveryView refresh effect),
                which conflicted with Final-Cut work and forced a re-render there. New
                takes are made with "Direct this shot" or "Regenerate with comments";
                this section stays a pure take SELECTOR. */}
            {shot?.videoUrl && takes.length > 1 && shot.status !== 'animating' && (
              <section className="border-t border-border pt-3">
                <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1.5">
                  Takes
                </p>
                <div className="flex flex-col gap-1">
                  {takes.map((t, i) => (
                      <button
                        key={t.id}
                        onClick={() => onSelectTake?.(t.id)}
                        disabled={isGenerating}
                        data-testid={`take-${i + 1}`}
                        className={cn(
                          'flex items-center justify-between px-2 py-1 rounded border text-[10px] transition-colors disabled:opacity-50',
                          t.id === selectedTakeId
                            ? 'border-cyan/60 bg-cyan/15 text-cyan'
                            : 'border-border bg-elevated text-text-muted hover:bg-text-primary/[0.04]',
                        )}
                      >
                        <span className="font-semibold">Take {i + 1}{t.id === selectedTakeId ? ' · current' : ''}</span>
                        <span className="font-mono">{t.resolution ?? ''}</span>
                      </button>
                  ))}
                </div>
              </section>
            )}

            {/* Draft→HD re-render removed: shots render straight to the final output
                size (Settings → Final output size), so there is no lower draft to
                upgrade. To change resolution, set it in Settings and re-render. */}

            {/* User manual approval section */}
            <section className="border-t border-border pt-3">
              <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-2.5">
                User Manual Approval
              </p>
              <ApprovalControls
                approveLabel="Approve Shot"
                onApprove={onApprove}
                onRegenerate={onRegenerate}
                canApprove={canApprove}
                isGenerating={isGenerating}
                feedback={feedback}
                onFeedbackChange={setFeedback}
                qcPassed={qcResult ? qcResult.passed : null}
                qcPersona={qcResult?.persona ?? 'Animation Director'}
              />
            </section>

            {/* Classical assets / LoRA selector removed — it was a non-functional
                placeholder ("Select Claude Agent Skill" did nothing) that only added
                clutter to this step. */}

            {/* Take One QC Agent card */}
            <section className="border-t border-border pt-3">
              <QCAgentCard qcResult={qcResult} />
            </section>
          </>
        )}

        {tab === 'status' && (
          <div className="flex flex-col gap-2 text-xs text-text-muted">
            <div className="flex justify-between">
              <span>Stage status</span>
              <span className="text-cyan font-mono">{stage5.status}</span>
            </div>
            <div className="flex justify-between">
              <span>Versions</span>
              <span className="text-cyan font-mono">{stage5.versions.length}</span>
            </div>
            <div className="flex justify-between">
              <span>Active shot</span>
              <span className="text-cyan font-mono truncate max-w-[120px]">{shot?.shotId ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span>Shot status</span>
              <span className="text-orange font-mono">{shot?.status ?? '—'}</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
