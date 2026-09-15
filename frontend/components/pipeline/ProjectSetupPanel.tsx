'use client'

import { useState, useEffect } from 'react'
import { Tv, Film, Zap, FolderOpen, CheckCircle, ChevronDown, ChevronUp, FolderSearch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { apiClient } from '@/lib/api/client'
import { FolderBrowser } from '@/components/pipeline/FolderBrowser'
import { forecastProjectCost, fmtCost } from '@/lib/costForecast'
import { planProjectLoad, type ProjectLoadResponse } from '@/lib/reconstructProject'
import { STYLE_PRESETS, CUSTOM_STYLE_DEFAULT } from '@/lib/styles'
import { usePipelineStore, type ProjectType, type ProjectStructure } from '@/store/pipeline.store'
import { useToast } from '@/components/ui/Toast'
import type { ProjectStyle, StyleId } from '@/lib/types/pipeline.types'

const TYPE_DEFS: Array<{
  id: ProjectType
  label: string
  icon: React.ElementType
  desc: string
  fields: Array<{ key: keyof ProjectStructure; label: string; placeholder: string; required: boolean }>
}> = [
  {
    id: 'tv',
    label: 'TV Series',
    icon: Tv,
    desc: 'Season / Episode / Scene',
    fields: [
      { key: 'season',  label: 'Season',  placeholder: '01',    required: true },
      { key: 'episode', label: 'Episode', placeholder: '01',    required: true },
      { key: 'scene',   label: 'Scene',   placeholder: '01',    required: true },
    ],
  },
  {
    id: 'film',
    label: 'Film',
    icon: Film,
    desc: 'Act / Scene',
    fields: [
      { key: 'act',   label: 'Act',   placeholder: 'Act 1', required: false },
      { key: 'scene', label: 'Scene', placeholder: '01',    required: true },
    ],
  },
  {
    id: 'vfx_shot',
    label: 'VFX Shot',
    icon: Zap,
    desc: 'Sequence / Shot',
    fields: [
      { key: 'sequence', label: 'Sequence', placeholder: 'SEQ010', required: true },
      { key: 'shot',     label: 'Shot',     placeholder: 'SH0010', required: true },
    ],
  },
]

// Dot color per style — matches StyleSelector colours
const STYLE_DOT: Record<StyleId, string> = {
  cinematic:  'bg-amber',
  photoreal:  'bg-cyan',
  anime:      'bg-pink-400',
  pixar3d:    'bg-orange',
  cartoon2d:  'bg-green',
  comic:      'bg-red',
  custom:     'bg-text-muted',
}

const ALL_PRESETS = [
  ...Object.values(STYLE_PRESETS),
  CUSTOM_STYLE_DEFAULT,
] as ProjectStyle[]


export function ProjectSetupPanel() {
  const projectName          = usePipelineStore((s) => s.projectName)
  const projectType          = usePipelineStore((s) => s.projectType)
  const projectStructure     = usePipelineStore((s) => s.projectStructure)
  const localFolderRoot      = usePipelineStore((s) => s.localFolderRoot)
  const setProjectMeta       = usePipelineStore((s) => s.setProjectMeta)
  const setProjectName       = usePipelineStore((s) => s.setProjectName)
  const setLocalFolderRoot   = usePipelineStore((s) => s.setLocalFolderRoot)
  const loadProjectState     = usePipelineStore((s) => s.loadProjectState)
  const currentStyle         = usePipelineStore((s) => s.style)
  const setStyle             = usePipelineStore((s) => s.setStyle)
  const targetDurationSecs   = usePipelineStore((s) => s.targetDurationSecs)
  // Draft behind the custom-duration field (see the input note below).
  const [durationDraft, setDurationDraft] = useState<string | null>(null)
  const setTargetDuration    = usePipelineStore((s) => s.setTargetDuration)
  const outputResolution     = usePipelineStore((s) => s.outputResolution)
  const videoModel           = usePipelineStore((s) => s.videoModel)
  const aspectRatio          = usePipelineStore((s) => s.aspectRatio)
  const setAspectRatio       = usePipelineStore((s) => s.setAspectRatio)
  const { success, error: toastError } = useToast()

  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'new' | 'open'>('new')
  const [selectedType, setSelectedType] = useState<ProjectType>(projectType)
  const [fields, setFields] = useState<Partial<ProjectStructure>>(projectStructure)
  const [isIniting, setIsIniting] = useState(false)
  const [storageRoot, setStorageRoot] = useState<string>('')   // custom path; empty = default
  const [browseOpen, setBrowseOpen] = useState(false)          // New-tab folder picker
  const [customSuffix, setCustomSuffix] = useState(
    currentStyle.id === 'custom' ? currentStyle.promptSuffix : ''
  )
  const [customNeg, setCustomNeg] = useState(
    currentStyle.id === 'custom' ? currentStyle.negativePrompt : ''
  )

  const typeDef = TYPE_DEFS.find((t) => t.id === selectedType)!

  // Fetch the backend default storage root on first open (to show as placeholder)
  const [defaultRoot, setDefaultRoot] = useState<string>('~/Documents/TakeOne')
  useEffect(() => {
    if (open && defaultRoot === '~/Documents/TakeOne') {
      apiClient.get<{ default_root: string }>('/api/project/storage-default')
        .then((r) => setDefaultRoot(r.data.default_root))
        .catch(() => {/* non-fatal */})
    }
  }, [open, defaultRoot])

  const handleApply = async () => {
    setIsIniting(true)
    try {
      const { data } = await apiClient.post<{ root: string }>('/api/project/init', {
        name: projectName,
        project_type: selectedType,
        structure: fields,
        storage_root: storageRoot.trim() || null,
      })
      setProjectMeta(selectedType, fields as ProjectStructure)
      setLocalFolderRoot(data.root)
      success('Project folder created', data.root)
      setOpen(false)
    } catch (e: unknown) {
      toastError('Failed to init project', e instanceof Error ? e.message : String(e))
    } finally {
      setIsIniting(false)
    }
  }

  const handleOpenProject = async (path: string) => {
    setIsIniting(true)
    try {
      const { data } = await apiClient.get<ProjectLoadResponse>('/api/project/load', { params: { path } })
      // The snapshot-vs-reconstruction decision lives in planProjectLoad so boot
      // (ProjectAutosave) restores a project EXACTLY the way Open does.
      const plan = planProjectLoad(data, path)

      if (plan.kind === 'reconstructed') {
        loadProjectState(plan.snapshot)
        success('Project reconstructed', 'Rebuilt from disk — review & re-approve as needed')
      } else if (plan.kind === 'snapshot') {
        loadProjectState(plan.snapshot)
        success('Project opened', data.manifest?.name ?? path)
      } else {
        // Truly empty folder — open it + manifest meta so generation can start.
        setLocalFolderRoot(path)
        if (data.manifest?.type) setProjectMeta(data.manifest.type as ProjectType, (data.manifest.structure ?? {}) as ProjectStructure)
        if (data.manifest?.name) setProjectName(data.manifest.name)
        toastError('No saved state', 'This project has no pipeline snapshot or artifacts yet — opened the folder, but the stages are empty.')
      }
      setOpen(false)
    } catch (e: unknown) {
      toastError('Failed to open project', e instanceof Error ? e.message : String(e))
    } finally {
      setIsIniting(false)
    }
  }

  const handleSelectStyle = (preset: ProjectStyle) => {
    if (preset.id === 'custom') {
      setStyle({ ...CUSTOM_STYLE_DEFAULT, promptSuffix: customSuffix, negativePrompt: customNeg })
    } else {
      setStyle(preset)
    }
  }

  return (
    <div className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen(!open)}
        data-testid="project-setup-trigger"
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-semibold transition-all',
          localFolderRoot
            ? 'text-green border-green/30 bg-green/10 hover:brightness-110'
            : 'text-text-muted border-border hover:bg-elevated hover:text-text-primary',
        )}
        title={localFolderRoot ?? 'Set project type & create local folder'}
      >
        {localFolderRoot ? <CheckCircle size={11} /> : <FolderOpen size={11} />}
        <span className="hidden sm:block">
          {/* Only show the project type once a real project exists — otherwise it
              defaults to "TV Series" and looks like a choice was made. */}
          {localFolderRoot ? (TYPE_DEFS.find((t) => t.id === projectType)?.label ?? 'Project') : 'Project Setup'}
        </span>
        {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
      </button>

      {/* Panel
          - right-0 keeps it inside the viewport when trigger is near the right edge
          - w-[320px] caps width so nothing runs off-screen
          - max-h-[min(80vh,640px)] + overflow-y-auto makes the whole panel scroll
            when content is taller than the viewport
          - overflow-y-auto is on a plain div (not the rounded wrapper) so border-
            radius clipping doesn't interfere with scrolling
      */}
      {open && (
        <div
          className={cn(
            'absolute top-full mt-1 right-0 z-50',
            'w-[320px]',
            'bg-surface border border-border rounded-lg',
            'shadow-[0_8px_32px_rgba(0,0,0,0.6)]',
            // Outer rounds corners; inner div handles scroll
          )}
        >
          {/* Sticky header + New/Open tabs */}
          <div className="px-3 py-2 border-b border-border shrink-0 rounded-t-lg bg-surface flex items-center justify-between">
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
              Project Setup
            </p>
            <div className="flex items-center gap-0.5 bg-elevated rounded p-0.5">
              {(['new', 'open'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  data-testid={`project-tab-${t}`}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] font-semibold capitalize transition-colors',
                    tab === t ? 'bg-cyan/20 text-cyan' : 'text-text-muted hover:text-text-primary',
                  )}
                >
                  {t === 'open' ? 'Open' : 'New'}
                </button>
              ))}
            </div>
          </div>

          {/* Scrollable body — max height relative to viewport */}
          <div
            className="overflow-y-auto overscroll-contain"
            style={{ maxHeight: 'min(80vh, 640px)' }}
            data-testid="project-setup-scroll"
          >
            {tab === 'open' ? (
              <div className="p-3 flex flex-col gap-2" data-testid="project-open-tab">
                <p className="text-[10px] text-text-dim">
                  Navigate to a project folder and open it. Folders holding an Take One Studio project are highlighted — click <span className="text-cyan font-semibold">Open</span>.
                </p>
                <FolderBrowser
                  mode="open"
                  initialPath={localFolderRoot ?? undefined}
                  onOpenProject={handleOpenProject}
                  heightClass="h-60"
                />
              </div>
            ) : (
            <>
            {/* ── Project type ── */}
            <div className="p-2 flex flex-col gap-1">
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest px-1 pt-1 pb-0.5">
                Project Type
              </p>
              {TYPE_DEFS.map((t) => {
                const Icon = t.icon
                return (
                  <button
                    key={t.id}
                    onClick={() => { setSelectedType(t.id); setFields({}) }}
                    className={cn(
                      'flex items-center gap-2.5 w-full text-left px-3 py-2 rounded-md transition-colors',
                      selectedType === t.id
                        ? 'bg-elevated border border-border'
                        : 'hover:bg-elevated/60',
                    )}
                  >
                    <Icon
                      size={14}
                      className={selectedType === t.id ? 'text-cyan' : 'text-text-muted'}
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">{t.label}</p>
                      <p className="text-[10px] text-text-muted">{t.desc}</p>
                    </div>
                    {selectedType === t.id && (
                      <CheckCircle size={11} className="text-cyan ml-auto shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>

            {/* ── Structure fields ── */}
            <div className="border-t border-border px-3 py-3 flex flex-col gap-2">
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest mb-0.5">
                Structure
              </p>
              {typeDef.fields.map((f) => (
                <div key={f.key} className="flex items-center gap-2">
                  <label className="text-[10px] text-text-muted w-16 shrink-0">{f.label}</label>
                  <input
                    type="text"
                    placeholder={f.placeholder}
                    value={(fields[f.key] as string) ?? ''}
                    onChange={(e) =>
                      setFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                    }
                    className="flex-1 min-w-0 bg-elevated border border-border rounded px-2 py-1 text-xs text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/40"
                  />
                  {f.required && <span className="text-red text-[10px] shrink-0">*</span>}
                </div>
              ))}
            </div>

            {/* ── Target Length ── */}
            <div className="border-t border-border px-3 py-3 flex flex-col gap-2">
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">
                Target Length
              </p>
              <p className="text-[10px] text-text-dim -mt-1">
                Tells Claude how many scenes and shots to write
              </p>
              <div className="grid grid-cols-4 gap-1">
                {([
                  { label: '30s',   secs: 30   },
                  { label: '1 min', secs: 60   },
                  { label: '3 min', secs: 180  },
                  { label: '5 min', secs: 300  },
                  { label: '10 min',secs: 600  },
                  { label: '15 min',secs: 900  },
                  { label: '20 min',secs: 1200 },
                  { label: '30 min',secs: 1800 },
                ] as const).map(({ label, secs }) => (
                  <button
                    key={secs}
                    onClick={() => { setTargetDuration(secs); setDurationDraft(null) }}
                    className={cn(
                      'py-1.5 rounded text-[10px] font-semibold border transition-all',
                      targetDurationSecs === secs
                        ? 'bg-cyan/20 border-cyan/60 text-cyan shadow-[var(--shadow-neon-cyan)]'
                        : 'bg-elevated border-border text-text-muted hover:border-cyan/30 hover:text-text-primary'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {/* Custom seconds input. A DRAFT string backs the field: binding the
                  store value directly made typing impossible (clearing → NaN →
                  rejected; typing "9" of "900" → below min → rejected). The draft
                  accepts anything; valid values commit live; blur re-syncs. */}
              <div className="flex items-center gap-2 mt-0.5">
                <label className="text-[9px] text-text-dim whitespace-nowrap">Custom (s):</label>
                <input
                  type="number"
                  min={10}
                  max={7200}
                  value={durationDraft ?? String(targetDurationSecs)}
                  onChange={(e) => {
                    setDurationDraft(e.target.value)
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v) && v >= 10 && v <= 7200) setTargetDuration(v)
                  }}
                  onBlur={() => setDurationDraft(null)}
                  className="flex-1 bg-elevated border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-cyan/40 font-mono"
                />
                <span className="text-[9px] text-text-dim">
                  ≈ {targetDurationSecs >= 60
                    ? `${Math.round(targetDurationSecs / 60 * 10) / 10} min`
                    : `${targetDurationSecs}s`}
                </span>
              </div>
            </div>

            {/* ── Estimated cost (pre-generation forecast) ── */}
            <div className="border-t border-border px-3 py-3" data-testid="cost-forecast">
              {(() => {
                const f = forecastProjectCost(targetDurationSecs, outputResolution, videoModel)
                return (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Estimated cost</p>
                      <span className="text-base font-bold text-cyan" data-testid="forecast-cost">~{fmtCost(f.costUsd)}</span>
                    </div>
                    <p className="text-[9px] text-text-dim mt-1">
                      ≈{f.shots} shots · ≈{f.videos} videos ({outputResolution}) · ≈{f.images} images
                    </p>
                    <p className="text-[9px] text-text-dim mt-0.5">Rough forecast — actual depends on the script. Resolution: Settings.</p>
                  </>
                )
              })()}
            </div>

            {/* ── Aspect Ratio ── */}
            <div className="border-t border-border px-3 py-3 flex flex-col gap-2">
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">
                Aspect Ratio
              </p>
              <p className="text-[10px] text-text-dim -mt-1">
                Locks keyframe pixels and video ratio — no center-crops
              </p>
              <div className="grid grid-cols-3 gap-1">
                {(['16:9', '9:16', '1:1'] as const).map((ar) => (
                  <button
                    key={ar}
                    onClick={() => setAspectRatio(ar)}
                    className={cn(
                      'py-1.5 rounded text-[10px] font-semibold border transition-all',
                      aspectRatio === ar
                        ? 'bg-cyan/20 border-cyan/60 text-cyan shadow-[var(--shadow-neon-cyan)]'
                        : 'bg-elevated border-border text-text-muted hover:border-cyan/30 hover:text-text-primary'
                    )}
                  >
                    {ar}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Visual Style — inline picker (no nested floating dropdown) ── */}
            <div className="border-t border-border px-3 py-3 flex flex-col gap-2">
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">
                Visual Style
              </p>
              <p className="text-[10px] text-text-dim -mt-1">
                Locks look for every asset in the project
              </p>

              <div className="flex flex-col gap-1" data-testid="style-preset-list">
                {ALL_PRESETS.map((preset) => {
                  const isSelected = currentStyle.id === preset.id
                  return (
                    <button
                      key={preset.id}
                      data-testid={`style-preset-${preset.id}`}
                      onClick={() => handleSelectStyle(preset)}
                      className={cn(
                        'flex items-start gap-2.5 w-full text-left px-3 py-2 rounded-md transition-colors',
                        isSelected
                          ? 'bg-elevated border border-border'
                          : 'hover:bg-elevated/60',
                      )}
                    >
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full mt-1 shrink-0',
                          STYLE_DOT[preset.id as StyleId] ?? 'bg-text-muted',
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-text-primary">
                            {preset.label}
                          </span>
                          {isSelected && (
                            <CheckCircle size={11} className="text-cyan shrink-0" />
                          )}
                        </div>
                        {preset.id !== 'custom' && (
                          <p className="text-[10px] text-text-muted mt-0.5 leading-relaxed">
                            {preset.promptSuffix.split(',').slice(0, 3).join(', ')}
                          </p>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>

              {/* Custom suffix/neg fields */}
              {currentStyle.id === 'custom' && (
                <div className="flex flex-col gap-2 pt-1">
                  <div>
                    <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest block mb-1">
                      Style Prompt Suffix
                    </label>
                    <textarea
                      value={customSuffix}
                      onChange={(e) => {
                        setCustomSuffix(e.target.value)
                        setStyle({
                          ...CUSTOM_STYLE_DEFAULT,
                          promptSuffix: e.target.value,
                          negativePrompt: customNeg,
                        })
                      }}
                      placeholder="e.g. cyberpunk neon noir, rain-soaked streets…"
                      rows={2}
                      className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/40 resize-none"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest block mb-1">
                      Negative Prompt
                    </label>
                    <textarea
                      value={customNeg}
                      onChange={(e) => {
                        setCustomNeg(e.target.value)
                        setStyle({
                          ...CUSTOM_STYLE_DEFAULT,
                          promptSuffix: customSuffix,
                          negativePrompt: e.target.value,
                        })
                      }}
                      placeholder="e.g. blurry, low quality…"
                      rows={1}
                      className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-red/40 resize-none"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* ── Storage location ── */}
            <div className="px-3 pb-2">
              <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest block mb-1">
                Storage Location
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={storageRoot}
                  onChange={(e) => setStorageRoot(e.target.value)}
                  placeholder={defaultRoot}
                  className="flex-1 min-w-0 bg-elevated border border-border rounded px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/40 font-mono"
                />
                <button
                  onClick={() => setBrowseOpen((v) => !v)}
                  data-testid="storage-browse"
                  title="Browse for a folder"
                  className={cn(
                    'p-1.5 rounded border transition-colors shrink-0',
                    browseOpen ? 'border-cyan/60 text-cyan bg-cyan/10' : 'border-border text-text-muted hover:text-cyan hover:border-cyan/30',
                  )}
                >
                  <FolderSearch size={13} />
                </button>
              </div>
              <p className="text-[9px] text-text-dim mt-0.5">Leave blank to use the default above, or Browse to pick.</p>
              {browseOpen && (
                <div className="mt-1.5">
                  <FolderBrowser
                    mode="pick"
                    initialPath={storageRoot || localFolderRoot || undefined}
                    onPathChange={(p) => setStorageRoot(p)}
                    heightClass="h-40"
                  />
                  <p className="text-[9px] text-text-dim mt-0.5">
                    The project folder <span className="text-text-muted font-mono">{projectName || '…'}</span> will be created inside the path above.
                  </p>
                </div>
              )}
            </div>

            {/* ── Folder path preview ── */}
            {localFolderRoot && (
              <div
                className="px-3 pb-2 text-[10px] text-green font-mono truncate"
                title={localFolderRoot}
              >
                <FolderOpen size={10} className="inline mr-1" />
                {localFolderRoot}
              </div>
            )}

            {/* ── Create button ── */}
            <div className="border-t border-border p-3">
              <Button
                variant="primary"
                size="sm"
                loading={isIniting}
                onClick={handleApply}
                className="w-full"
              >
                {localFolderRoot ? 'Re-create Folder' : 'Create Project Folder'}
              </Button>
            </div>
            </>
            )}
          </div>{/* end scrollable body */}
        </div>
      )}
    </div>
  )
}
