// One id per bus channel the backend publishes on (server.py `bus.publish(<id>, …)`).
// 'tts' was missing while the backend already published dialogue/voice events on it, so
// the SSE bridge wrote an entry with no id and no label into the store and the monitor
// drew a blank card — including the "spoke in a GENERIC voice" warning.
export type AgentId = 'story' | 'breakdown' | 'cinematic' | 'qc' | 'seedream' | 'seedance' | 'tts'

export type AgentStatus = 'idle' | 'active' | 'inactive' | 'completed' | 'error'

export interface AgentState {
  id: AgentId
  label: string
  sublabel?: string
  status: AgentStatus
  detail: string
  progress?: number // 0-100
}

export interface AgentSkill {
  id: string
  label: string
  description: string
}
