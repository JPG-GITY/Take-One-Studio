'use client'

import { useCallback, useRef } from 'react'
import { usePipelineStore } from '@/store/pipeline.store'

/**
 * Guard for async completion handlers that write to the pipeline store.
 *
 * Stage views remount when the project changes (key={projectId}), but their
 * in-flight async closures (render polls, QC auto-approve, batch loops) SURVIVE
 * the unmount. A dead closure's setState calls are dropped by React — but store
 * actions (commitVersion / patchStageData / approveVersion) are not: they write
 * into whatever project the store holds NOW. That is exactly how FAIL 8's shots
 * got committed into FAIL 7's stage 5 when a render finished after a project
 * switch (cross-project contamination, persisted by autosave).
 *
 * Usage: const isCurrentProject = useProjectGuard()
 *        …in any async completion path, before writing to the store:
 *        if (!isCurrentProject()) return
 */
export function useProjectGuard(): () => boolean {
  const mountedProjectId = useRef(usePipelineStore.getState().projectId)
  return useCallback(
    () => usePipelineStore.getState().projectId === mountedProjectId.current,
    [],
  )
}
