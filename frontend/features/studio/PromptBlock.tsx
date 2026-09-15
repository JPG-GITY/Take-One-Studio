'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/** How many lines a collapsed prompt shows. Two is enough for a structured Seedance 2.5
 *  prompt to read as its own summary — `[Generation Goal]` plus the goal sentence — and
 *  short enough that a feed of forty cards is still a feed and not a wall. */
const COLLAPSED_LINES = 2

interface Props {
  id: string
  prompt: string
}

/**
 * The prompt above a gallery card. The card used to print the whole prompt in a bare
 * `<p>` with no line breaks, so a thirty-line structured 2.5 prompt became one grey
 * paragraph the reader had to wade through to reach the media.
 *
 * Collapsed to COLLAPSED_LINES by default. The toggle appears ONLY when the text
 * actually overflows — measured, not guessed from length — so a one-line prompt never
 * grows a pointless button. Expanded, the prompt keeps its own line breaks
 * (`whitespace-pre-wrap`), which is what makes the `[Section]` structure legible, and
 * offers Copy. Expansion is per-card component state: it is a reading aid, not a
 * setting, so it is not persisted.
 */
export function PromptBlock({ id, prompt }: Props) {
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLParagraphElement>(null)

  // Measure whether the clamp is hiding anything — in LINES, against the computed
  // line-height, so a font's descender rounding can never count as a hidden line.
  // Re-measured on resize (the line count follows the column width) and once the web
  // fonts land: measured in the fallback font, a one-line prompt briefly wrapped to two
  // and grew a toggle that vanished a frame later.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      if (open) return
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20
      setOverflows(Math.round(el.scrollHeight / lh) > COLLAPSED_LINES)
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    let cancelled = false
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => { if (!cancelled) measure() })
    }
    return () => { cancelled = true; ro?.disconnect() }
  }, [prompt, open])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard denied — nothing to recover, the text is on screen */ }
  }, [prompt])

  const showToggle = overflows || open
  return (
    <div className="mb-1.5" data-testid={`studio-prompt-${id}`} data-open={open ? '1' : '0'}>
      <p
        ref={ref}
        className={cn('text-sm text-text-primary', open ? 'whitespace-pre-wrap' : 'line-clamp-2')}
        style={open ? undefined : { WebkitLineClamp: COLLAPSED_LINES }}
      >
        {prompt}
      </p>
      {showToggle && (
        <div className="flex items-center gap-1 mt-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            data-testid={`studio-prompt-toggle-${id}`}
            aria-expanded={open}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-[10px] text-text-muted hover:text-text-primary hover:border-text-dim"
            title={open ? 'Collapse the prompt' : 'Show the whole prompt'}
          >
            Prompt {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </button>
          {open && (
            <button
              type="button"
              onClick={() => void copy()}
              data-testid={`studio-prompt-copy-${id}`}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-[10px] text-text-muted hover:text-cyan hover:border-cyan/40"
              title="Copy the prompt"
            >
              {copied ? <Check size={10} className="text-green" /> : <Copy size={10} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
