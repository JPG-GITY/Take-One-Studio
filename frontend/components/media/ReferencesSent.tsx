'use client'

import { cn } from '@/lib/utils'

export interface SentRef {
  url: string
  label: string
  /** What the parent keys an exclusion by (asset folder or label). Set by the stage. */
  key?: string
}

interface Props {
  /** Las referencias DERIVADAS, en el orden exacto en que se envían al modelo. Sin recortar:
   *  el recorte se muestra, no se aplica aquí (ver `cap`). */
  refs: SentRef[]
  /** El tope del modelo. Lo que caiga fuera se pinta tachado en vez de desaparecer, que es lo
   *  que hacía antes. Omitirlo cuando no hay tope conocido. */
  cap?: number
  /** Cabecera. Por defecto "References sent". */
  title?: string
  testId?: string
  /** When given, every derived reference gets a "don't send" control. The stage owns the
   *  decision and where it is kept; this only reports the click. */
  onExclude?: (ref: SentRef) => void
  /** The derived references the director took out, listed under the sent ones with a way
   *  back — a choice that cannot be seen is a choice that gets forgotten. */
  excluded?: SentRef[]
  onRestore?: (ref: SentRef) => void
}

/**
 * QUÉ SE VA A ADJUNTAR A ESTA GENERACIÓN.
 *
 * Las etapas derivan sus referencias solas, las recortan al tope del modelo y las envían. Sin
 * esta lista el director paga una generación sin saber qué lleva, y el recorte descarta en
 * silencio — el caso que lo motivó fue una etapa que dejaba fuera referencias al llegar al tope
 * sin decirlo en ningún sitio.
 *
 * No es lo mismo que `PromptPanel.refs`, que pinta una tira de miniaturas y no sabe nada de
 * topes ni de descartes; los dos pueden convivir. Esto nació a mano en la tarjeta de plano de
 * la etapa 5 y sale aquí porque la etapa 4 necesita exactamente lo mismo para el tablero.
 */
export function ReferencesSent({ refs, cap, title = 'References sent', testId, onExclude, excluded = [], onRestore }: Props) {
  const dropped = cap != null && refs.length > cap ? refs.length - cap : 0
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-bold tracking-widest uppercase text-text-muted">
          {title}
        </span>
        {dropped > 0 && (
          <span className="text-[10px] text-amber" data-testid={testId ? `${testId}-truncated` : undefined}>
            {dropped} dropped — {cap} max
          </span>
        )}
      </div>
      {refs.length > 0 && (
        <ol className="flex flex-col gap-0.5">
          {refs.map((r, i) => (
            <li key={`${r.url}-${i}`}
                className={cn('flex items-center gap-1 text-[10px] leading-snug',
                  cap != null && i >= cap ? 'text-text-dim line-through' : 'text-text-muted')}
                title={r.label}>
              <span className="truncate">{i + 1}. {r.label}</span>
              {onExclude && (
                <button onClick={() => onExclude(r)} title="Don't send this one" aria-label={`Don't send: ${r.label}`}
                  data-testid={testId ? `${testId}-exclude-${i}` : undefined}
                  className="ml-auto shrink-0 px-1 rounded text-text-dim hover:text-red hover:bg-red/10 leading-none">×</button>
              )}
            </li>
          ))}
        </ol>
      )}
      {excluded.length > 0 && (
        <div className="flex flex-col gap-0.5" data-testid={testId ? `${testId}-excluded` : undefined}>
          <span className="text-[10px] text-amber">Not sent ({excluded.length})</span>
          {excluded.map((r, i) => (
            <div key={`${r.key ?? r.url}-${i}`} className="flex items-center gap-1 text-[10px] text-text-dim leading-snug" title={r.label}>
              <span className="truncate line-through">{r.label}</span>
              {onRestore && (
                <button onClick={() => onRestore(r)} data-testid={testId ? `${testId}-restore-${i}` : undefined}
                  className="ml-auto shrink-0 text-cyan hover:underline">restore</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
