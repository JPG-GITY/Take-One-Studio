'use client'

/**
 * Prompt Transparency (item 0): ONE reusable panel for every model-bound
 * prompt in the app — asset prompts, identity boards, storyboard panels,
 * keyframes, the Claude-written Seedance direction prompt.
 *
 * Contract: the agent (or assembler) PROPOSES, the user can AMEND, then
 * generates. Whatever is in the textarea is sent VERBATIM. After generation,
 * the read-only "Sent prompt" view shows what actually went out.
 */

import { useState } from 'react'
import { FileText, Sparkles, RotateCcw, ChevronDown, ChevronUp, Image as ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EnhanceButton } from './EnhanceButton'
import { cn } from '@/lib/utils'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

/** Local disk paths render through the serve endpoint; URLs pass through. */
export function promptRefSrc(ref: string): string {
  if (ref.startsWith('/') || ref.startsWith('file://')) {
    return `${API_BASE}/api/asset/serve?path=${encodeURIComponent(ref.replace('file://', ''))}`
  }
  return ref
}

export interface PromptRef {
  url: string
  label: string          // role, e.g. "image 1 — character headshot"
}

interface PromptPanelProps {
  /** Panel heading, e.g. "Identity Board Prompt", "Seedance Direction" */
  title: string
  /** The auto-assembled prompt (null = not assembled yet) — basis for the edited badge */
  autoPrompt: string | null
  /** Current editable text */
  value: string
  onChange: (v: string) => void
  /** Negative prompt (editable) — omit to hide the field */
  negative?: string
  onNegativeChange?: (v: string) => void
  /** Ordered reference list, exactly as attached to the model call */
  refs?: PromptRef[]
  /** When given, each reference gets a "don't send" control — the stage decides what
   *  that means (a derived one is excluded, an attached one is detached) and rebuilds. */
  onRemoveRef?: (index: number) => void
  /** Derived references the director took out, shown under the strip with a way back. */
  excludedRefs?: PromptRef[]
  onRestoreRef?: (index: number) => void
  /** What the Enhance button tells the server this text IS. Defaults to the title (a
   *  prose field); a stage passes 'seedance_direction' to get the guide-checked rewrite. */
  enhanceField?: string
  /** Context for that rewrite — for a Seedance direction, JSON with the model version. */
  enhanceContext?: string
  /** What actually went out on the last generation (read-only view) */
  sentPrompt?: string | null
  /** Button label, e.g. "Generate 4 Identity Boards" */
  generateLabel: string
  onGenerate: () => void
  /** Re-assemble the auto prompt (discards edits) */
  onReset?: () => void
  onCancel?: () => void
  busy?: boolean
  disabled?: boolean
  defaultOpen?: boolean
  testId?: string
}

export function PromptPanel({
  title, autoPrompt, value, onChange, negative, onNegativeChange, refs, onRemoveRef, excludedRefs, onRestoreRef,
  enhanceField, enhanceContext,
  sentPrompt, generateLabel, onGenerate, onReset, onCancel,
  busy, disabled, defaultOpen = true, testId = 'prompt-panel',
}: PromptPanelProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [showSent, setShowSent] = useState(false)
  const edited = autoPrompt !== null && value.trim() !== autoPrompt.trim()

  return (
    <div className="flex flex-col rounded-lg border border-cyan/40 bg-cyan/5" data-testid={testId}>
      {/* Header — collapsible */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 text-left hover:bg-cyan/10 transition-colors rounded-t-lg"
      >
        <FileText size={12} className="text-cyan shrink-0" />
        <span className="text-[10px] font-semibold text-cyan uppercase tracking-widest flex-1">
          {title} — review &amp; edit before generating
        </span>
        {edited && (
          <span className="px-1.5 py-0.5 rounded bg-orange/15 border border-orange/40 text-orange text-[9px] font-bold uppercase tracking-wider"
            data-testid={`${testId}-edited-badge`}>
            edited
          </span>
        )}
        {open ? <ChevronUp size={12} className="text-text-muted" /> : <ChevronDown size={12} className="text-text-muted" />}
      </button>

      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={Math.min(14, Math.max(5, value.split('\n').length + 1))}
            spellCheck={false}
            disabled={disabled || busy}
            data-testid={`${testId}-textarea`}
            className={cn(
              'w-full bg-elevated border border-border rounded px-3 py-2',
              'text-[11px] font-mono leading-relaxed text-text-primary',
              'focus:outline-none focus:border-cyan/50 focus:ring-1 focus:ring-cyan/20 resize-y',
              'disabled:opacity-50'
            )}
          />

          {onNegativeChange && (
            <div>
              <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest block mb-1">
                Negative prompt
              </label>
              <textarea
                value={negative ?? ''}
                onChange={(e) => onNegativeChange(e.target.value)}
                rows={2}
                spellCheck={false}
                disabled={disabled || busy}
                placeholder="What the model must avoid…"
                data-testid={`${testId}-negative`}
                className={cn(
                  'w-full bg-elevated border border-border rounded px-3 py-1.5',
                  'text-[10px] font-mono text-text-primary placeholder:text-text-dim',
                  'focus:outline-none focus:border-red/40 focus:ring-1 focus:ring-red/15 resize-y',
                  'disabled:opacity-50'
                )}
              />
            </div>
          )}

          {/* Ordered reference list — thumbnail + role, exactly as attached */}
          {refs && refs.length > 0 && (
            <div data-testid={`${testId}-refs`}>
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest mb-1">
                <ImageIcon size={9} className="inline mr-1" />References ({refs.length})
              </p>
              <div className="flex gap-2 flex-wrap">
                {refs.map((r, i) => (
                  <div key={i} className="relative flex items-center gap-1.5 px-1.5 py-1 rounded border border-border bg-elevated max-w-[230px]"
                    data-testid={`${testId}-ref-${i}`}>
                    <img src={promptRefSrc(r.url)} alt={r.label}
                      className="w-9 h-9 object-cover rounded shrink-0" />
                    <span className={cn('text-[9px] text-text-muted leading-tight', onRemoveRef && 'pr-3')}>
                      <span className="text-cyan font-mono">image {i + 1}</span> — {r.label}
                    </span>
                    {onRemoveRef && (
                      <button onClick={() => onRemoveRef(i)} title="Don't send this one" aria-label={`Don't send: ${r.label}`}
                        data-testid={`${testId}-ref-remove-${i}`}
                        className="absolute top-0.5 right-1 px-1 rounded text-text-dim hover:text-red hover:bg-red/10 leading-none text-[11px]">×</button>
                    )}
                  </div>
                ))}
              </div>
              {excludedRefs && excludedRefs.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-0.5" data-testid={`${testId}-refs-excluded`}>
                  <span className="text-[9px] text-amber">Not sent ({excludedRefs.length})</span>
                  {excludedRefs.map((r, i) => (
                    <div key={`${r.url}-${i}`} className="flex items-center gap-1 text-[9px] text-text-dim leading-tight" title={r.label}>
                      <span className="truncate line-through">{r.label}</span>
                      {onRestoreRef && (
                        <button onClick={() => onRestoreRef(i)} data-testid={`${testId}-ref-restore-${i}`}
                          className="shrink-0 text-cyan hover:underline">restore</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="primary" size="sm" icon={<Sparkles size={12} />}
              onClick={onGenerate} loading={busy} disabled={disabled || !value.trim()}
              data-testid={`${testId}-generate`}>
              {generateLabel}
            </Button>
            <EnhanceButton value={value} onEnhanced={onChange} field={enhanceField ?? title} context={enhanceContext}
              disabled={disabled || busy} />
            {onReset && (
              <Button variant="ghost" size="sm" icon={<RotateCcw size={11} />}
                onClick={onReset} disabled={disabled || busy}
                data-testid={`${testId}-reset`}>
                Reset to auto
              </Button>
            )}
            {onCancel && (
              <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            )}
            <span className="ml-auto text-[9px] text-text-dim">
              {value.length} chars — sent verbatim
            </span>
          </div>

          {/* Read-only record of what actually went out last time */}
          {sentPrompt && (
            <div className="border-t border-border pt-2">
              <button onClick={() => setShowSent((s) => !s)}
                className="text-[9px] font-semibold text-text-muted uppercase tracking-widest hover:text-text-primary transition-colors"
                data-testid={`${testId}-sent-toggle`}>
                {showSent ? '▾' : '▸'} Sent prompt (last generation)
              </button>
              {showSent && (
                <pre className="mt-1.5 p-2 bg-elevated/60 rounded border border-border text-[10px] font-mono text-text-muted whitespace-pre-wrap break-words max-h-48 overflow-y-auto"
                  data-testid={`${testId}-sent`}>
                  {sentPrompt}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
