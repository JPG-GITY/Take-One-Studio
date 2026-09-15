'use client'

/**
 * Local filesystem folder navigator, backed by `/api/fs/list` (this server runs
 * on the user's own machine). Two modes:
 *   - 'pick' → choose any folder (e.g. where to save a NEW project)
 *   - 'open' → navigate to and open an existing Take One Studio project (folders that
 *              hold a project.json show an "Open" affordance)
 * Used by ProjectSetupPanel's New + Open tabs.
 */

import { useState, useEffect, useCallback } from 'react'
import { Folder, FolderOpen, CornerLeftUp, Home, Loader2 } from 'lucide-react'
import { apiClient } from '@/lib/api/client'
import { cn } from '@/lib/utils'

interface FsEntry { name: string; path: string; isDir: boolean; hasProject: boolean }
interface FsList { path: string; parent: string | null; home: string; isProject: boolean; entries: FsEntry[] }

interface Props {
  initialPath?: string
  mode: 'pick' | 'open'
  /** Fires whenever the browsed directory changes (so the parent can capture it). */
  onPathChange?: (path: string) => void
  /** 'open' mode: fires when the user opens a project folder. */
  onOpenProject?: (path: string) => void
  heightClass?: string
}

export function FolderBrowser({ initialPath, mode, onPathChange, onOpenProject, heightClass = 'h-44' }: Props) {
  const [data, setData] = useState<FsList | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (path?: string) => {
    setLoading(true); setError(null)
    try {
      const { data } = await apiClient.get<FsList>('/api/fs/list', { params: path ? { path } : {} })
      setData(data)
      onPathChange?.(data.path)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot read this folder')
    } finally {
      setLoading(false)
    }
  }, [onPathChange])

  // Initial fetch on mount. The loading flag it sets is intended (not a cascading
  // render) — defer one microtask so it isn't a synchronous setState in the effect.
  useEffect(() => { void Promise.resolve().then(() => load(initialPath)) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-1" data-testid="folder-browser">
      {/* Path bar: home · up · current path */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => data?.home && load(data.home)}
          title="Home" data-testid="fb-home"
          className="p-1 rounded text-text-muted hover:text-cyan hover:bg-elevated transition-colors"
        >
          <Home size={11} />
        </button>
        <button
          onClick={() => data?.parent && load(data.parent)}
          disabled={!data?.parent}
          title="Up one level" data-testid="fb-up"
          className="p-1 rounded text-text-muted hover:text-cyan hover:bg-elevated disabled:opacity-30 transition-colors"
        >
          <CornerLeftUp size={11} />
        </button>
        <span className="flex-1 min-w-0 truncate text-[10px] font-mono text-text-muted" title={data?.path} data-testid="fb-path">
          {data?.path ?? '…'}
        </span>
      </div>

      {/* Entries */}
      <div className={cn('overflow-y-auto border border-border rounded bg-elevated/40', heightClass)}>
        {loading && (
          <div className="p-3 text-center text-text-dim text-[10px]">
            <Loader2 size={12} className="inline animate-spin mr-1" /> loading…
          </div>
        )}
        {error && <div className="p-3 text-[10px] text-red">{error}</div>}
        {!loading && !error && data?.entries.length === 0 && (
          <div className="p-3 text-[10px] text-text-dim text-center">No sub-folders here</div>
        )}
        {!loading && !error && data?.entries.map((e) => (
          <button
            key={e.path}
            onClick={() => load(e.path)}
            data-testid={`fb-entry-${e.name}`}
            className="flex items-center gap-2 w-full text-left px-2 py-1 hover:bg-elevated text-[11px] transition-colors"
          >
            {e.hasProject
              ? <FolderOpen size={12} className="text-cyan shrink-0" />
              : <Folder size={12} className="text-text-muted shrink-0" />}
            <span className="flex-1 min-w-0 truncate text-text-primary">{e.name}</span>
            {e.hasProject && mode === 'open' && (
              <span
                role="button" tabIndex={0}
                onClick={(ev) => { ev.stopPropagation(); onOpenProject?.(e.path) }}
                onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); onOpenProject?.(e.path) } }}
                data-testid={`fb-open-${e.name}`}
                className="text-[9px] font-semibold text-cyan border border-cyan/40 rounded px-1.5 py-0.5 hover:bg-cyan/10 shrink-0"
              >
                Open
              </span>
            )}
            {e.hasProject && mode === 'pick' && <span className="text-[8px] text-cyan shrink-0">project</span>}
          </button>
        ))}
      </div>

      {/* 'open' mode: open the current folder itself when it's a project */}
      {mode === 'open' && data?.isProject && (
        <button
          onClick={() => onOpenProject?.(data.path)}
          data-testid="fb-open-current"
          className="text-[10px] font-semibold text-cyan border border-cyan/40 rounded px-2 py-1 hover:bg-cyan/10 transition-colors"
        >
          Open this folder as project
        </button>
      )}
    </div>
  )
}
