'use client'

import { useState, useEffect, useCallback } from 'react'
import { History, RotateCcw, CheckCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiClient } from '@/lib/api/client'
import { Button } from '@/components/ui/Button'
import { usePipelineStore } from '@/store/pipeline.store'
import { useToast } from '@/components/ui/Toast'

interface VersionEntry {
  path: string
  version: number
}

interface Props {
  assetRelPath: string   // e.g. "Assets/Characters/Jack"
  projectName: string
  currentUrl: string | null
  onReverted: (url: string) => void
}

export function VersionHistoryPanel({ assetRelPath, projectName, currentUrl, onReverted }: Props) {
  const localFolderRoot = usePipelineStore((s) => s.localFolderRoot)
  const { success, error: toastError } = useToast()

  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [current, setCurrent] = useState<number | null>(null)
  const [approved, setApproved] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [reverting, setReverting] = useState<number | null>(null)

  const fetchVersions = useCallback(async () => {
    if (!localFolderRoot) return
    try {
      const { data } = await apiClient.get<{
        versions: string[]
        current: number | null
        approved: number | null
      }>('/api/asset/versions', { params: { name: projectName, asset_rel_path: assetRelPath, project_path: localFolderRoot ?? '' } })
      const entries: VersionEntry[] = data.versions.map((p) => {
        const match = p.match(/v(\d+)\.png$/)
        return { path: p, version: match ? parseInt(match[1], 10) : 0 }
      })
      setVersions(entries)
      setCurrent(data.current)
      setApproved(data.approved)
    } catch {
      // Versions not available — folder may not be initialised yet
    }
  }, [projectName, localFolderRoot, assetRelPath])

  useEffect(() => {
    // Defer one microtask so the loading flag isn't a synchronous setState in the effect
    if (open) void Promise.resolve().then(fetchVersions)
  }, [open, fetchVersions])

  const handleRevert = async (version: number) => {
    setReverting(version)
    try {
      await apiClient.post('/api/asset/revert', {
        name: projectName,
        asset_rel_path: assetRelPath,
        version,
        project_path: localFolderRoot ?? '',
      })
      setCurrent(version)
      // Serve the file from local path — build a URL the browser can load
      // In local mode the backend can serve from /api/static/ if needed;
      // for now we just notify parent so it can refresh via re-generate or re-load
      success('Reverted', `Version v${version.toString().padStart(3, '0')} restored`)
      onReverted(`v${version.toString().padStart(3, '0')}`)
    } catch (e: unknown) {
      toastError('Revert failed', e instanceof Error ? e.message : String(e))
    } finally {
      setReverting(null)
    }
  }

  if (!localFolderRoot) return null

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-cyan transition-colors"
      >
        <History size={11} />
        Version history
        {versions.length > 0 && (
          <span className="font-mono text-text-dim">({versions.length})</span>
        )}
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-border bg-elevated overflow-hidden">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">
              Saved versions — revert never deletes history
            </p>
          </div>
          {versions.length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-text-dim">
              No saved versions yet. Approve an asset to save v001.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {[...versions].reverse().map((v) => (
                <div
                  key={v.version}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2',
                    v.version === current && 'bg-cyan/5',
                  )}
                >
                  <span className="text-[10px] font-mono text-text-muted w-10">
                    v{v.version.toString().padStart(3, '0')}
                  </span>

                  {v.version === approved && (
                    <CheckCircle size={11} className="text-green shrink-0" />
                  )}
                  {v.version === current && v.version !== approved && (
                    <span className="text-[9px] text-cyan font-semibold">current</span>
                  )}

                  <div className="flex-1" />

                  {v.version !== current && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<RotateCcw size={11} />}
                      loading={reverting === v.version}
                      onClick={() => handleRevert(v.version)}
                      className="text-[10px]"
                    >
                      Revert
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
