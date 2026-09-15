'use client'

// Reusable "Enhance" button for any prompt / instruction / notes box. Rewrites the
// current text into a stronger version with Seed 2.0 Pro (NOT the Claude budget)
// and hands it back via onEnhanced — drop it next to any textarea. Non-destructive:
// it only replaces the text when the model returns something.

import { useState } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { pipelineApi } from '@/lib/api/pipeline.api'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/utils'

export function EnhanceButton({
  value, onEnhanced, field = 'prompt', context = '', disabled, className, label = 'Enhance',
}: {
  /** Current text in the box. */
  value: string
  /** Called with the improved text. */
  onEnhanced: (text: string) => void
  /** What kind of box this is (guides the rewrite), e.g. 'director note', 'image prompt'. */
  field?: string
  /** Optional extra context (asset/shot description) to ground the rewrite. */
  context?: string
  disabled?: boolean
  className?: string
  label?: string
}) {
  const { error, warning } = useToast()
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!value.trim()) { error('Nothing to enhance', 'Write something first.'); return }
    setBusy(true)
    try {
      const { text, warnings } = await pipelineApi.enhanceTextChecked(field, value, context)
      // A guide-checked rewrite that failed its check comes back EMPTY with the reasons:
      // the director's text stays and the reasons are shown — a silent no-op would read
      // as "Enhance does nothing" and a bad rewrite would read as "Enhance made it worse".
      if (!text.trim() && warnings.length) {
        warning('Enhance kept your text', `The rewrite broke the Seedance guide: ${warnings.slice(0, 3).join(' · ').slice(0, 220)}`)
        return
      }
      if (text.trim()) onEnhanced(text.trim())
    } catch (e) {
      error('Enhance failed', (e instanceof Error ? e.message : String(e)).slice(0, 140))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={disabled || busy || !value.trim()}
      title="Rewrite this into a stronger prompt (Seed 2.0 Pro)"
      className={cn(
        'flex items-center gap-1 px-2 py-1 rounded border border-cyan/40 text-[10px] font-medium text-cyan',
        'hover:bg-cyan/10 transition-colors disabled:opacity-40 disabled:cursor-default shrink-0',
        className,
      )}
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />} {label}
    </button>
  )
}
