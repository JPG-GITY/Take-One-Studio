'use client'

import { useEffect, useState } from 'react'

/** A long Seedance render must never read as frozen: ticking elapsed time plus
 *  the typical range for the target resolution. */
export function RenderTimer({ startedAt, resolution, compact }: {
  startedAt?: number
  resolution?: string
  compact?: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (!startedAt) return null
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  if (compact) return <span className="font-mono">{clock}</span>
  const typical = resolution === '1080p' ? '5–10 min' : resolution === '720p' ? '2–5 min' : '1–3 min'
  return (
    <span data-testid="render-timer">
      Rendering{resolution ? ` ${resolution}` : ''} · <span className="font-mono">{clock}</span> elapsed
      <span className="opacity-70"> (typical {typical})</span>
    </span>
  )
}
