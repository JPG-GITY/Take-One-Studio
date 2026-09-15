'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { usePipelineStore } from '@/store/pipeline.store'
import { PipelineStepper } from '@/components/pipeline/PipelineStepper'
import { TopBar } from '@/components/pipeline/TopBar'
import { AgentStatusMonitor } from '@/components/agent/AgentStatusMonitor'
import { AutopilotController } from '@/components/pipeline/AutopilotController'
import { ProjectAutosave } from '@/components/pipeline/ProjectAutosave'
import { ScriptIngestionView } from '@/features/stage1-script/ScriptIngestionView'
import { BreakdownView } from '@/features/stage2-breakdown/BreakdownView'
import { AssetGenerationView } from '@/features/stage3-assets/AssetGenerationView'
import { StoryboardView } from '@/features/stage4-storyboard/StoryboardView'
import { FinalGenView } from '@/features/stage5-final-gen/FinalGenView'
import { DeliveryView } from '@/features/stage6-delivery/DeliveryView'
import { StudioView } from '@/features/studio/StudioView'
import { useAgentsStore } from '@/store/agents.store'

// Pipeline: Script · Breakdown · AG · Storyboard · SG · Final Cut & Export
const STAGE_VIEWS = {
  1: ScriptIngestionView,
  2: BreakdownView,
  3: AssetGenerationView,
  4: StoryboardView,
  5: FinalGenView,
  6: DeliveryView,
} as const

function AgentSocketBridge() {
  const { updateAgent } = useAgentsStore()

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
    let es: EventSource | null = null
    let retryDelay = 2000   // start at 2s
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false

    function connect() {
      if (destroyed) return

      es = new EventSource(`${apiUrl}/api/agents/stream`)

      es.onmessage = (event) => {
        retryDelay = 2000 // reset backoff on successful message
        try {
          const data = JSON.parse(event.data)
          if (data.ping) return
          updateAgent(data.agent_id, {
            status: data.status,
            detail: data.detail,
            ...(data.progress !== undefined && { progress: data.progress }),
          })
        } catch { /* ignore malformed frames */ }
      }

      es.onerror = () => {
        es?.close()
        es = null
        if (destroyed) return
        // Exponential backoff, capped at 30s
        retryDelay = Math.min(retryDelay * 1.5, 30_000)
        retryTimer = setTimeout(connect, retryDelay)
      }
    }

    connect()

    return () => {
      destroyed = true
      if (retryTimer) clearTimeout(retryTimer)
      es?.close()
    }
  }, [updateAgent])

  return null
}

// Reads the backend's /api/health (which already reports key presence) and warns
// up front when a key is missing or the API is down — so a misconfigured setup
// shows a clear banner instead of failing opaquely on the first generation.
function ConfigBanner() {
  const [issues, setIssues] = useState<string[]>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
    fetch(`${apiUrl}/api/health`)
      .then((r) => r.json())
      .then((d: { claude?: string; byteplus?: string }) => {
        const probs: string[] = []
        if (d.claude && d.claude !== 'configured') probs.push(d.claude)
        if (d.byteplus && d.byteplus !== 'configured') probs.push(d.byteplus)
        setIssues(probs)
      })
      .catch(() => setIssues(['Backend unreachable on :8000 — is the API server running?']))
  }, [])

  if (dismissed || issues.length === 0) return null
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-red/10 border-b border-red/40 text-red text-[12px] shrink-0"
      data-testid="config-banner">
      <AlertTriangle size={14} className="shrink-0" />
      <span className="flex-1">Configuration issue — {issues.join(' · ')}</span>
      <button onClick={() => setDismissed(true)} className="text-red/70 hover:text-red transition-colors shrink-0">
        <X size={13} />
      </button>
    </div>
  )
}

export default function DashboardPage() {
  const activeStage = usePipelineStore((s) => s.activeStage)
  // projectId changes only on Reset / Open — keying the view on it remounts the
  // stage views then, clearing any local component state (e.g. the Script
  // concept/draft) for a true fresh start. Navigation between stages keeps it.
  const projectId = usePipelineStore((s) => s.projectId)
  const [studioMode, setStudioMode] = useState(false)
  const ActiveView = STAGE_VIEWS[activeStage]

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <TopBar />
      <ConfigBanner />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left nav: pipeline stepper + Studio toggle */}
        <PipelineStepper
          studioMode={studioMode}
          onStudioToggle={() => setStudioMode((v) => !v)}
        />

        {/* Center workspace: pipeline stages OR Studio tab */}
        <main className="flex flex-col flex-1 min-w-0 overflow-hidden bg-bg">
          {studioMode ? <StudioView /> : <ActiveView key={projectId} />}
        </main>

        <AgentStatusMonitor />
      </div>

      {/* SSE bridge — no UI, just subscribes to backend agent events */}
      <AgentSocketBridge />
      {/* P5c: Autopilot driver — no UI, runs the auto-draft chain when started */}
      <AutopilotController />
      {/* Per-project disk autosave — no UI, mirrors the store snapshot to the project folder */}
      <ProjectAutosave />
    </div>
  )
}
