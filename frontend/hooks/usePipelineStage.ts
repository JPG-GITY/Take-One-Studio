import { usePipelineStore } from '@/store/pipeline.store'
import type { StageId, StageSlice } from '@/lib/types/pipeline.types'

export function usePipelineStage(stageId: StageId): StageSlice & {
  activeData: unknown
  canEdit: boolean
} {
  const stage = usePipelineStore((s) => s.stages[stageId])

  const activeData = stage.activeVersionId
    ? stage.versions.find((v) => v.id === stage.activeVersionId)?.data ?? null
    : null

  const canEdit = stage.status !== 'generating'

  return { ...stage, activeData, canEdit }
}
