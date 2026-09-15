'use client'

import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { CheckCircle, AlertTriangle, Info, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: string
  type: ToastType
  title: string
  message?: string
  duration?: number
}

interface ToastContextValue {
  toast: (opts: Omit<Toast, 'id'>) => void
  success: (title: string, message?: string) => void
  error:   (title: string, message?: string) => void
  warning: (title: string, message?: string) => void
  info:    (title: string, message?: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const ICONS: Record<ToastType, React.ElementType> = {
  success: CheckCircle,
  error:   XCircle,
  warning: AlertTriangle,
  info:    Info,
}

const STYLES: Record<ToastType, string> = {
  success: 'border-green/40 bg-green/10  text-green',
  error:   'border-red/40   bg-red/10    text-red',
  warning: 'border-orange/40 bg-orange/10 text-orange',
  info:    'border-cyan/40  bg-cyan/10   text-cyan',
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = ICONS[toast.type]

  useEffect(() => {
    // Errors and warnings stay until the user dismisses them — a failed
    // generation's message must be readable, not gone in 4s. An explicit
    // `duration` always wins (allows a sticky success or a timed error).
    const sticky = toast.duration === undefined && (toast.type === 'error' || toast.type === 'warning')
    if (sticky || toast.duration === Infinity) return
    const t = setTimeout(onDismiss, toast.duration ?? 4000)
    return () => clearTimeout(t)
  }, [toast.duration, toast.type, onDismiss])

  return (
    <div className={cn(
      'flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg backdrop-blur',
      'animate-in slide-in-from-right-4 fade-in duration-200',
      'max-w-sm w-full',
      STYLES[toast.type],
      'bg-surface/90'
    )}>
      <Icon size={15} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary">{toast.title}</p>
        {toast.message && (
          <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">{toast.message}</p>
        )}
      </div>
      <button onClick={onDismiss} data-testid="toast-dismiss" className="text-text-muted hover:text-text-primary transition-colors shrink-0">
        <X size={13} />
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback((opts: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((prev) => [...prev.slice(-4), { ...opts, id }])
  }, [])

  const success = useCallback((title: string, message?: string) => toast({ type: 'success', title, message }), [toast])
  const error   = useCallback((title: string, message?: string) => toast({ type: 'error',   title, message }), [toast])
  const warning = useCallback((title: string, message?: string) => toast({ type: 'warning', title, message }), [toast])
  const info    = useCallback((title: string, message?: string) => toast({ type: 'info',    title, message }), [toast])

  return (
    <ToastContext.Provider value={{ toast, success, error, warning, info }}>
      {children}
      {/* Portal */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <ToastItem toast={t} onDismiss={() => dismiss(t.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
