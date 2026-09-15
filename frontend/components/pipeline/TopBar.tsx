'use client'

import { useState } from 'react'
import { RotateCcw, FolderOpen, ChevronDown, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePipelineStore } from '@/store/pipeline.store'
import { useAgentsStore } from '@/store/agents.store'
import { pipelineApi } from '@/lib/api/pipeline.api'
import { StatusBadge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { ProjectSetupPanel } from '@/components/pipeline/ProjectSetupPanel'
import { AutopilotPanel } from '@/components/pipeline/AutopilotPanel'
import { SettingsMenu } from '@/components/pipeline/SettingsMenu'

export function TopBar() {
  const { projectName, setProjectName, activeStage, stages, resetPipeline, gateMode, setGateMode } = usePipelineStore()
  const { resetAgents } = useAgentsStore()
  const { success } = useToast()
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(projectName)
  const [confirmReset, setConfirmReset] = useState(false)

  const handleReset = () => {
    resetPipeline()
    resetAgents()
    setConfirmReset(false)
    // F2c: resetPipeline forgets the browser's copy of the project root, but the BACKEND
    // also remembers the last project worked on, and boot falls back to it precisely when
    // localStorage is empty — which is the state a reset leaves behind. Without this the
    // next reload reopens the project just cleared, and Reset is also the way out offered
    // when that fallback opens a project the user did not ask for. Fire-and-forget: a
    // backend that is down must not block a local reset.
    pipelineApi.forgetLastProject().catch(() => {})
    success('Project reset', 'All stages and agents cleared. Ready for a new project.')
  }

  const approvedCount = Object.values(stages).filter((s) => s.status === 'approved').length
  const activeStageStatus = stages[activeStage].status

  const commitName = () => {
    if (nameValue.trim()) setProjectName(nameValue.trim())
    setEditingName(false)
  }

  return (
    <header className="flex items-center gap-3 px-4 h-11 bg-surface border-b border-border shrink-0 z-10">
      {/* App brand */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-5 h-5 rounded bg-cyan/10 border border-cyan/30 flex items-center justify-center">
          <span className="text-cyan text-[9px] font-bold font-mono">T</span>
        </div>
        <span className="text-[10px] font-bold tracking-[0.2em] text-cyan uppercase glow-cyan hidden sm:block">
          Take One Studio
        </span>
        <span className="text-[9px] text-text-muted hidden lg:block">AI Cinema Engine</span>
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Project name — editable */}
      <div className="flex items-center gap-1.5">
        <FolderOpen size={11} className="text-text-muted shrink-0" />
        {editingName ? (
          <input
            autoFocus
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') setEditingName(false)
            }}
            className="bg-elevated border border-cyan/40 rounded px-2 py-0.5 text-xs text-text-primary focus:outline-none w-48 font-mono"
          />
        ) : (
          <button
            onClick={() => { setNameValue(projectName); setEditingName(true) }}
            className="text-xs font-semibold text-text-primary hover:text-cyan transition-colors font-mono flex items-center gap-1"
          >
            {projectName}
            <ChevronDown size={10} className="text-text-muted" />
          </button>
        )}
      </div>

      {/* Pipeline progress pills */}
      <div className="hidden md:flex items-center gap-1 ml-2">
        {([1, 2, 3, 4, 5, 6] as const).map((id) => {
          const s = stages[id]
          return (
            <div
              key={id}
              title={`Stage ${id}`}
              className={cn(
                'w-2 h-2 rounded-full transition-all',
                s.status === 'approved'       ? 'bg-green'
                : s.status === 'generating'   ? 'bg-amber animate-pulse'
                : s.status === 'pending_review' ? 'bg-orange'
                : s.status === 'invalidated'  ? 'bg-red'
                : id === activeStage          ? 'bg-cyan'
                : 'bg-border'
              )}
            />
          )
        })}
        <span className="text-[10px] text-text-muted ml-1 font-mono">
          {approvedCount}/6
        </span>
      </div>

      {/* Current stage status */}
      <div className="hidden lg:block">
        <StatusBadge status={activeStageStatus} />
      </div>

      <div className="flex-1" />

      {/* Right controls */}
      <div className="flex items-center gap-1">
        {/* P5: project type + local folder setup */}
        <ProjectSetupPanel />

        <div className="h-4 w-px bg-border mx-1" />

        {/* P5c: Autopilot — auto-draft script + breakdown from a concept */}
        <AutopilotPanel />

        {/* P5b: auto-approve on QC pass — fewer manual clicks */}
        <button
          onClick={() => setGateMode(gateMode === 'auto' ? 'manual' : 'auto')}
          data-testid="gatemode-toggle"
          title={gateMode === 'auto'
            ? 'Auto-approve is ON — items whose QC passes approve themselves'
            : 'Manual approval — click to auto-approve on QC pass'}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold rounded border transition-all mr-1',
            gateMode === 'auto'
              ? 'text-amber border-amber/50 bg-amber/10'
              : 'text-text-muted border-border hover:text-amber hover:border-amber/30',
          )}
        >
          <Zap size={11} />
          Auto{gateMode === 'auto' ? ' ✓' : ''}
        </button>

        <SettingsMenu />

        {/* Reset with confirm */}
        {confirmReset ? (
          <div className="flex items-center gap-1.5 bg-red/10 border border-red/30 rounded px-2 py-1">
            <span className="text-[10px] text-red font-semibold">Reset all?</span>
            <button
              onClick={handleReset}
              className="text-[10px] text-red font-bold hover:underline"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirmReset(false)}
              className="text-[10px] text-text-muted hover:text-text-primary"
            >
              No
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmReset(true)}
            className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-text-muted hover:text-red rounded hover:bg-red/10 transition-all border border-transparent hover:border-red/20"
          >
            <RotateCcw size={11} />
            Reset
          </button>
        )}
      </div>
    </header>
  )
}
