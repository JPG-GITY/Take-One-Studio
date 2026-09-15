'use client'

import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Wifi, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentsStore } from '@/store/agents.store'
import type { AgentState, AgentStatus } from '@/lib/types/agents.types'

function useBackendStatus() {
  const [connected, setConnected] = useState<boolean | null>(null) // null = checking

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>

    const check = () => {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
      fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(2000) })
        .then(() => setConnected(true))
        .catch(() => setConnected(false))
        .finally(() => { timer = setTimeout(check, 8000) })
    }
    check()

    return () => clearTimeout(timer)
  }, [])

  return connected
}

const STATUS_RING: Record<AgentStatus, string> = {
  active:    'border-orange shadow-[var(--shadow-neon-orange)]',
  idle:      'border-cyan/40',
  inactive:  'border-border opacity-60',
  completed: 'border-green/60',
  error:     'border-red shadow-[var(--shadow-neon-red)]',
}

const STATUS_TEXT: Record<AgentStatus, string> = {
  active:    'text-orange',
  idle:      'text-cyan',
  inactive:  'text-text-muted',
  completed: 'text-green',
  error:     'text-red',
}

const STATUS_DOT: Record<AgentStatus, string> = {
  active:    'bg-orange animate-pulse',
  idle:      'bg-text-muted',
  inactive:  'bg-border',
  completed: 'bg-green',
  error:     'bg-red animate-pulse',
}

const LOGOS: Record<string, string> = {
  story:     '✦',
  breakdown: '◈',
  cinematic: '⬡',
  qc:        '✦',
  seedream:  '✦',
  seedance:  '▲',
  tts:       '♪',
}

function AgentCard({ agent }: { agent: AgentState }) {
  const [expanded, setExpanded] = useState(agent.status === 'active')

  return (
    <div className={cn(
      'rounded-lg border overflow-hidden transition-all duration-200',
      agent.status === 'active'
        ? 'border-orange/50 bg-orange/5'
        : 'border-border bg-elevated'
    )}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-text-primary/[0.04] transition-colors"
      >
        {/* Avatar */}
        <div className={cn(
          'w-7 h-7 rounded-full border-2 flex items-center justify-center shrink-0 text-xs',
          STATUS_RING[agent.status]
        )}>
          <span className={STATUS_TEXT[agent.status]}>{LOGOS[agent.id] ?? '●'}</span>
        </div>

        <div className="flex-1 text-left min-w-0">
          <p className="text-[11px] font-semibold text-text-primary leading-tight truncate">
            {agent.label}
          </p>
          {agent.sublabel && (
            <p className={cn('text-[9px] font-semibold uppercase tracking-wider', STATUS_TEXT[agent.status])}>
              ({agent.sublabel}):{' '}
              <span className={cn(agent.status === 'active' ? 'text-orange font-bold' : '')}>
                {agent.status.toUpperCase()}
              </span>
            </p>
          )}
          {!agent.sublabel && (
            <p className={cn('text-[9px] uppercase tracking-wider', STATUS_TEXT[agent.status])}>
              {agent.status}
            </p>
          )}
        </div>

        <span className="text-text-muted shrink-0">
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>

      {expanded && agent.detail && (
        <div className="px-3 pb-2.5 flex flex-col gap-1.5">
          {/* Progress bar for active agents */}
          {agent.progress !== undefined && (
            <div className="h-1 bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-orange to-orange/60 transition-all duration-500"
                style={{ width: `${agent.progress}%` }}
              />
            </div>
          )}

          {/* Status dot + detail */}
          <div className="flex items-center gap-1.5">
            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATUS_DOT[agent.status])} />
            <p className="text-[10px] text-text-muted leading-relaxed">{agent.detail}</p>
          </div>
        </div>
      )}
    </div>
  )
}

const COLLAPSE_KEY = 'takeone-agentpanel-collapsed'

export function AgentStatusMonitor() {
  const agents = useAgentsStore((s) => s.agents)
  const backendConnected = useBackendStatus()
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
  })
  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(COLLAPSE_KEY, n ? '1' : '0') } catch { /* */ } return n })
  const activeCount = Object.values(agents).filter((a) => a.status === 'active').length
  const connDot = backendConnected === null ? 'bg-amber animate-pulse' : backendConnected ? 'bg-green' : 'bg-red'

  // Collapsed: a thin rail you can click to reopen (state is remembered).
  if (collapsed) {
    return (
      <aside className="w-9 shrink-0 flex flex-col items-center gap-3 py-2 bg-surface border-l border-border" data-testid="agent-status-rail">
        <button onClick={toggle} title="Show Agent Status" data-testid="agent-status-expand" className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-elevated">
          <ChevronLeft size={14} />
        </button>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', connDot)} />
        <span className="text-[9px] font-semibold tracking-widest text-text-muted uppercase [writing-mode:vertical-rl]">Agent Status</span>
        {activeCount > 0 && <span className="mt-auto text-[10px] font-bold text-orange" title={`${activeCount} active`}>{activeCount}</span>}
      </aside>
    )
  }

  return (
    <aside className="w-[260px] shrink-0 flex flex-col bg-surface border-l border-border overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <button onClick={toggle} title="Collapse panel" data-testid="agent-status-collapse" className="p-0.5 -ml-1 rounded text-text-muted hover:text-text-primary hover:bg-elevated">
            <ChevronRight size={14} />
          </button>
          <div>
            <p className="text-[10px] font-semibold tracking-widest text-text-muted uppercase">
              Agent Status
            </p>
            <p className="text-[9px] text-text-dim mt-0.5">Monitor</p>
          </div>
        </div>
        {/* Backend connection indicator */}
        <div className="flex items-center gap-1.5" title={
          backendConnected === null ? 'Checking backend…'
          : backendConnected ? 'Backend connected'
          : 'Backend offline — agents unavailable'
        }>
          {backendConnected === null ? (
            <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
          ) : backendConnected ? (
            <Wifi size={11} className="text-green" />
          ) : (
            <WifiOff size={11} className="text-red" />
          )}
          <span className={cn('text-[9px] font-semibold',
            backendConnected === null ? 'text-amber'
            : backendConnected ? 'text-green'
            : 'text-red'
          )}>
            {backendConnected === null ? '…' : backendConnected ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
      </div>

      {/* Agent cards */}
      <div className="flex flex-col gap-1.5 p-2 overflow-y-auto flex-1">
        {Object.values(agents).map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>

      {/* Footer: active workloads summary */}
      <div className="px-3 py-2 border-t border-border shrink-0">
        <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest mb-1.5">
          Active Workloads
        </p>
        <div className="flex flex-col gap-1">
          {Object.values(agents)
            .filter((a) => a.status === 'active')
            .map((a) => (
              <div key={a.id} className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-orange animate-pulse shrink-0" />
                <span className="text-[9px] text-text-muted truncate">{a.detail}</span>
              </div>
            ))}
        </div>
      </div>
    </aside>
  )
}
