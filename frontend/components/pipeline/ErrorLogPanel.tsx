'use client'

/**
 * Persistent error log (opened from Settings). Toasts vanish and the Agent Status
 * panel only shows the CURRENT state — this reads the backend's error ring buffer
 * (/api/errors): every HTTP 4xx/5xx raised by an endpoint plus every agent-bus
 * error event, newest first, with timestamps. Survives page reloads (buffer lives
 * in the backend process; cleared only when the backend restarts).
 */

import { useState, useEffect, useCallback } from 'react'
import { X, RefreshCw, Loader2, AlertTriangle, ShieldAlert } from 'lucide-react'
import { apiClient } from '@/lib/api/client'

interface ErrorEntry {
  ts: string
  kind: 'http' | 'agent'
  source: string      // "POST /api/video/create → 400" | agent id ("seedance")
  detail: string
}

export function ErrorLogPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<ErrorEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const { data } = await apiClient.get<{ errors: ErrorEntry[] }>('/api/errors')
      setEntries(data.errors)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load error log')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void Promise.resolve().then(load) }, [load])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" data-testid="error-log-panel">
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[680px] max-w-[94vw] max-h-[85vh] overflow-y-auto bg-surface border border-border rounded-xl shadow-[0_12px_48px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border sticky top-0 bg-surface z-10">
          <div>
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <ShieldAlert size={14} className="text-red" /> Error log
            </h2>
            <p className="text-[10px] text-text-muted">
              Every backend error since the last restart — newest first
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={load} title="Refresh" className="p-1.5 rounded text-text-muted hover:text-cyan hover:bg-elevated transition-colors">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
            <button onClick={onClose} data-testid="error-log-close" className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-elevated transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="p-4">
          {error ? (
            <p className="text-xs text-red py-8 text-center">{error} — is the backend running?</p>
          ) : entries === null ? (
            <p className="text-xs text-text-muted py-8 text-center"><Loader2 size={14} className="inline animate-spin mr-1" /> loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-text-muted py-8 text-center">No errors since the backend started. 🎉</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {entries.map((e, i) => (
                <div key={i} className="rounded-lg border border-border bg-elevated/40 px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <AlertTriangle size={11} className={e.kind === 'http' ? 'text-red shrink-0' : 'text-orange shrink-0'} />
                    <span className="text-[10px] font-mono font-semibold text-text-primary">{e.source}</span>
                    <span className="text-[9px] text-text-dim font-mono ml-auto shrink-0">
                      {new Date(e.ts).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-[11px] text-text-muted mt-1 leading-snug break-words">{e.detail}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
