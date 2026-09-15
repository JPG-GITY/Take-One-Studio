'use client'

import { create } from 'zustand'
import type { AgentId, AgentState, AgentStatus } from '@/lib/types/agents.types'

// All agents start truly idle — no fake "active" placeholders
const IDLE_AGENTS: Record<AgentId, AgentState> = {
  story: {
    id: 'story',
    label: 'Take One Story Agent',
    status: 'idle',
    detail: 'Waiting for script generation',
  },
  breakdown: {
    id: 'breakdown',
    label: 'Take One Breakdown Agent',
    status: 'inactive',
    detail: 'Waiting for breakdown task',
  },
  cinematic: {
    id: 'cinematic',
    label: 'Take One Cinematic Agent',
    status: 'idle',
    detail: 'Waiting for scene breakdown',
  },
  qc: {
    id: 'qc',
    label: 'Take One QC Agent',
    sublabel: 'Final Review',
    status: 'idle',
    detail: 'Waiting for content to review',
  },
  seedream: {
    id: 'seedream',
    label: 'Seedream 5.0 Generation',
    status: 'inactive',
    detail: 'Waiting for asset generation',
  },
  seedance: {
    id: 'seedance',
    label: 'Seedance 2.0 Engine',
    status: 'inactive',
    detail: 'Waiting for scene generation',
    progress: 0,
  },
  tts: {
    id: 'tts',
    label: 'Seed Audio 1.0 Voice',
    status: 'inactive',
    detail: 'Waiting for dialogue',
  },
}

interface AgentsStore {
  agents: Record<AgentId, AgentState>
  updateAgent: (id: AgentId, patch: Partial<AgentState>) => void
  setAgentStatus: (id: AgentId, status: AgentStatus, detail?: string) => void
  resetAgents: () => void
}

export const useAgentsStore = create<AgentsStore>((set) => ({
  agents: { ...IDLE_AGENTS },

  updateAgent: (id, patch) =>
    set((s) => ({
      agents: { ...s.agents, [id]: { ...s.agents[id], ...patch } },
    })),

  setAgentStatus: (id, status, detail) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [id]: { ...s.agents[id], status, ...(detail !== undefined && { detail }) },
      },
    })),

  resetAgents: () =>
    set(() => ({
      agents: Object.fromEntries(
        Object.entries(IDLE_AGENTS).map(([k, v]) => [k, { ...v }])
      ) as Record<AgentId, AgentState>,
    })),
}))
