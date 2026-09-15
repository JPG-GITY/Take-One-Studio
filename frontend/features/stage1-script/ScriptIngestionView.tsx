'use client'

import { useState, useEffect, useRef } from 'react'
import { FileText, Wand2, CheckCircle, Upload, Save, PencilLine, Sparkles } from 'lucide-react'
import { useProjectGuard } from '@/lib/useProjectGuard'
import { StageHeader } from '@/components/pipeline/StageHeader'
import { ApprovalControls } from '@/components/pipeline/ApprovalControls'
import { EnhanceButton } from '@/components/pipeline/EnhanceButton'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { QCActionCard, QCRunningCard } from '@/components/agent/QCActionCard'
import { usePipelineStore } from '@/store/pipeline.store'
import { useAgentsStore } from '@/store/agents.store'
import { useToast } from '@/components/ui/Toast'
import { pipelineApi, type QCResponse } from '@/lib/api/pipeline.api'
import { apiClient } from '@/lib/api/client'
import { measureScriptRuntime, useScriptRuntime } from '@/lib/scriptRuntime'
import { cn } from '@/lib/utils'
import type { ScriptData } from '@/lib/types/pipeline.types'

/** Same duration wording Stage 2's runtime badge uses. */
const secsLabel = (s: number) => (s >= 60 ? `${Math.round((s / 60) * 10) / 10} min` : `${Math.round(s)}s`)

export function ScriptIngestionView() {
  const { commitVersion, approveVersion, goToStage, stages, patchStageData, projectName, localFolderRoot, targetDurationSecs, requestSpineDerive } = usePipelineStore()
  const { updateAgent } = useAgentsStore()
  const { success, error: toastError } = useToast()
  const stage = stages[1]

  // Rehydrate local state from persisted store on mount
  const storedData = stage.activeVersionId
    ? (stage.versions.find((v) => v.id === stage.activeVersionId)?.data as ScriptData | undefined)
    : undefined

  const [concept,      setConcept]      = useState(storedData?.concept  ?? '')
  const [script,       setScript]       = useState(storedData?.content  ?? '')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isQcRunning,  setIsQcRunning]  = useState(false)
  const [qcResult,     setQcResult]     = useState<QCResponse | null>(null)
  const [feedback,     setFeedback]     = useState('')
  const [errorMsg,     setErrorMsg]     = useState<string | null>(null)
  // Item 1: load a custom script (file or paste)
  const [pasteText,    setPasteText]    = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Item 2: in-place editing of the script
  const [draft,        setDraft]        = useState<string | null>(null)
  const isEdited = !!storedData?.edited
  // Live runtime of what is in the editor, measured by the backend (debounced, and
  // null until the first answer lands — nothing to show beats a wrong number).
  const runtime = useScriptRuntime(draft ?? script)
  // Item 1c: optional "Develop idea" phase — expand the concept + answer N selection
  // questions BEFORE the one-shot Generate. Q/A in progress is local state; only the
  // finalized answers get persisted (via the commitVersion below). Guarded so a
  // completion from a switched-away project can't write the new project's state.
  const isCurrentProject = useProjectGuard()
  const [questions,       setQuestions]       = useState<Array<{ id: string; question: string; options: string[] }>>([])
  const [answers,         setAnswers]         = useState<Record<string, string>>({})
  const [expandedConcept, setExpandedConcept] = useState(storedData?.expandedConcept ?? '')
  const [isDeveloping,    setIsDeveloping]    = useState(false)

  // Persist a script to disk (loaded or edited) — same Script/ tree as generation
  const saveToDisk = async (content: string) => {
    try {
      await apiClient.post('/api/script/save', {
        script: content, concept,
        project_name: projectName, project_path: localFolderRoot ?? '',
      })
    } catch (e) {
      console.warn('[script/save] disk save failed (non-fatal):', e)
    }
  }

  // Item 1: a loaded script becomes the stage script exactly as if generated —
  // committed to the store, saved to disk, and run through the Film Director gate
  const adoptScript = async (content: string, sourceLabel: string) => {
    const text = content.trim()
    if (!text) return
    setScript(text)
    setDraft(null)
    // Runtime comes from the backend's duration maths now (words/130 read ~2× the
    // film). measureScriptRuntime never throws, but it IS a round trip — so the
    // commit below is guarded like every other post-await store write here.
    const rt = await measureScriptRuntime(text)
    if (!isCurrentProject()) return
    commitVersion<ScriptData>(1, {
      concept: concept || `(loaded: ${sourceLabel})`,
      content: text,
      wordCount: text.split(/\s+/).length,
      estimatedRuntime: Math.round(rt.seconds / 60),
      estimatedRuntimeSecs: rt.seconds,
      runtimeApprox: rt.approx,
      edited: true,
    })
    await saveToDisk(text)
    success('Script loaded', sourceLabel)
    setIsQcRunning(true)
    updateAgent('qc', { status: 'active', detail: 'Script QC running…' })
    try {
      const qc = await pipelineApi.qcScript(text, concept || sourceLabel)
      setQcResult(qc)
      updateAgent('qc', { status: qc.passed ? 'completed' : 'active', detail: qc.summary })
    } catch {
      updateAgent('qc', { status: 'idle', detail: 'QC skipped (offline)' })
    } finally {
      setIsQcRunning(false)
    }
  }

  const handleFileLoad = async (file: File) => {
    const text = await file.text()
    await adoptScript(text, file.name)
  }

  // Item 2: save hand edits — store + disk; downstream stages read this content
  const handleSaveEdits = async () => {
    if (draft === null) return
    const text = draft
    setScript(text)
    setDraft(null)
    const rt = await measureScriptRuntime(text)
    if (!isCurrentProject()) return
    patchStageData(1, {
      content: text,
      wordCount: text.split(/\s+/).length,
      estimatedRuntime: Math.round(rt.seconds / 60),
      estimatedRuntimeSecs: rt.seconds,
      runtimeApprox: rt.approx,
      edited: true,
    })
    await saveToDisk(text)
    success('Script saved', 'Edits persist to store + disk')
  }

  // Sync if the user rolls back to a different version
  useEffect(() => {
    if (!stage.activeVersionId) return
    const v = stage.versions.find((v) => v.id === stage.activeVersionId)
    const data = v?.data as ScriptData | undefined
    if (data) {
      // Defer one microtask so the rollback sync isn't a synchronous setState in the effect
      void Promise.resolve().then(() => {
        setConcept(data.concept ?? '')
        setScript(data.content ?? '')
        setDraft(null)
      })
    }
  }, [stage.activeVersionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Item 1c: "Develop idea" — expand the concept into selection questions (Claude).
  // Optional side-path; leaves the one-shot Generate untouched.
  const handleDevelop = async () => {
    if (!concept.trim()) return
    setIsDeveloping(true)
    setErrorMsg(null)
    updateAgent('story', { status: 'active', detail: 'Developing your idea…' })
    try {
      const out = await pipelineApi.expandConcept(concept, targetDurationSecs)
      if (!isCurrentProject()) return
      setExpandedConcept(out.expanded_concept)
      setQuestions(out.questions)
      setAnswers({})
      updateAgent('story', { status: 'idle', detail: 'Idea developed — answer the questions' })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Develop failed'
      setErrorMsg(msg)
      toastError('Develop idea failed', msg)
      updateAgent('story', { status: 'error', detail: msg })
    } finally {
      setIsDeveloping(false)
    }
  }

  const handleGenerate = async (withFeedback?: string) => {
    if (!concept.trim()) return
    setIsGenerating(true)
    setErrorMsg(null)
    setQcResult(null)
    updateAgent('story', { status: 'active', detail: 'Generating script…' })

    try {
      // Item 1c: fold the Develop-idea output (expanded premise + answered selection
      // questions) into the concept. When Develop is unused, base === concept and no
      // extra fields are committed → the one-shot path stays byte-for-byte identical.
      const answered = questions.filter((q) => answers[q.id])
      const qaBlock = answered.length
        ? '\n\nCreative choices:\n' + answered.map((q) => `- ${q.question} ${answers[q.id]}`).join('\n')
        : ''
      const base = expandedConcept.trim() ? expandedConcept.trim() + qaBlock : concept

      const effectiveConcept = withFeedback
        ? `${base}\n\nDirector feedback: ${withFeedback}`
        : base

      // PAIRED with AutopilotController's stage-1 call — the other caller of this
      // endpoint, which builds its body from the autopilot box alone. Anything ADDED
      // here belongs there too, or an unattended run sends a reduced version of it.
      const data = await pipelineApi.generateScript(effectiveConcept, projectName, localFolderRoot ?? '', targetDurationSecs)
      if (!isCurrentProject()) return   // a switched-away project must not adopt this result
      setScript(data.content)
      const rt = await measureScriptRuntime(data.content)
      if (!isCurrentProject()) return
      commitVersion<ScriptData>(1, {
        concept,
        content: data.content,
        wordCount: data.content.split(/\s+/).length,
        estimatedRuntime: Math.round(rt.seconds / 60),
        estimatedRuntimeSecs: rt.seconds,
        runtimeApprox: rt.approx,
        // Item 1c: persist the develop output ONLY when used (keeps the plain path clean)
        ...(expandedConcept.trim() ? { expandedConcept: expandedConcept.trim() } : {}),
        ...(answered.length ? { qa: answered.map((q) => ({ question: q.question, options: q.options, answer: answers[q.id] })) } : {}),
      })
      updateAgent('story', { status: 'idle', detail: 'Script ready' })

      // Try Claude QC — non-blocking
      setIsQcRunning(true)
      updateAgent('qc', { status: 'active', detail: 'Script QC running…' })
      try {
        // Judge tone-match against the real user concept, not script[:200]
        const qc = await pipelineApi.qcScript(data.content, concept)
        setQcResult(qc)
        updateAgent('qc', { status: qc.passed ? 'completed' : 'active', detail: qc.summary })
      } catch {
        updateAgent('qc', { status: 'idle', detail: 'QC skipped (offline)' })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Generation failed'
      setErrorMsg(msg)
      toastError('Script generation failed', msg)
      updateAgent('story', { status: 'error', detail: msg })
    } finally {
      setIsGenerating(false)
      setIsQcRunning(false)
    }
  }

  const handleApprove = () => {
    if (!stage.activeVersionId) return
    approveVersion(1, stage.activeVersionId)
    // The story spine is derived from the APPROVED script and the shot list is written
    // from the spine, so this is the only moment it can exist while it is still arguable.
    // Until now it was a button on a tab nobody had a reason to open, so in practice the
    // spine was born inside the breakdown — after the shots it decides had been written.
    // The panel does the work (it owns the request, the spinner and the errors) and it
    // REFUSES on a project that already has one; this only asks.
    requestSpineDerive()
    success('Script approved ✓', 'Reading the story spine →')
    goToStage(2)
  }

  // QC is advisory — you can approve as long as there is generated content
  const canApprove = stage.status === 'pending_review'

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StageHeader stageId={1} label="Script" />

      <div className="flex flex-1 min-h-0 gap-3 p-3">
        {/* Left: controls — scrollable so a long "Develop the idea" panel (premise +
            N questions + Write Script) is fully reachable instead of clipping the button
            and squashing the concept box (min-h-0 lets it shrink inside the flex parent). */}
        <div className="flex flex-col gap-3 w-72 shrink-0 overflow-y-auto min-h-0 pr-1">
          <Card className="shrink-0">
            <CardBody className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <label className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                  Film / Episode Concept
                </label>
                <EnhanceButton className="ml-auto" value={concept} onEnhanced={setConcept}
                  field="film or episode concept / logline" disabled={stage.status === 'approved'} />
              </div>
              <textarea
                value={concept}
                onChange={(e) => setConcept(e.target.value)}
                placeholder="e.g. A cybernetic detective investigates a murder in Neo-Tokyo 2089…"
                rows={5}
                disabled={stage.status === 'approved'}
                className={cn(
                  'w-full bg-elevated border border-border rounded px-3 py-2',
                  'text-sm text-text-primary placeholder:text-text-dim',
                  'focus:outline-none focus:border-cyan/50 focus:ring-1 focus:ring-cyan/20',
                  'resize-none transition-colors disabled:opacity-50'
                )}
              />
              {/* Stacked full-width in the narrow w-72 column — side-by-side overflowed
                  the card. "Develop idea" (optional enrich) sits above "Generate Script". */}
              <div className="flex flex-col gap-2">
                {/* Item 1c: optional — develop the idea into selection questions first */}
                <Button
                  variant="ghost"
                  icon={<Sparkles size={14} />}
                  loading={isDeveloping}
                  onClick={handleDevelop}
                  disabled={!concept.trim() || stage.status === 'approved' || isGenerating}
                  className="w-full"
                >
                  Develop idea
                </Button>
                <Button
                  variant="primary"
                  icon={<Wand2 size={14} />}
                  loading={isGenerating}
                  onClick={() => handleGenerate()}
                  disabled={!concept.trim() || stage.status === 'approved'}
                  className="w-full"
                >
                  Generate Script
                </Button>
              </div>
            </CardBody>
          </Card>

          {/* Item 1c: Develop-idea panel — appears after "Develop idea" returns. The
              answers fold into the concept on "Write Script" (the same handleGenerate,
              so the one-shot path is untouched). Q/A in progress is local state. */}
          {questions.length > 0 && stage.status !== 'approved' && (
            <Card className="shrink-0">
              <CardBody className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Sparkles size={12} className="text-cyan" />
                  <label className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                    Develop the idea
                  </label>
                </div>
                {expandedConcept.trim() && (
                  <p className="text-[11px] text-text-muted leading-relaxed border-l-2 border-cyan/30 pl-2 max-h-40 overflow-y-auto">
                    {expandedConcept}
                  </p>
                )}
                {questions.map((q) => (
                  <div key={q.id} className="flex flex-col gap-1.5">
                    <p className="text-[11px] font-medium text-text-primary">{q.question}</p>
                    <div className="flex flex-col gap-1">
                      {q.options.map((opt) => (
                        <label key={opt} className="flex items-center gap-2 text-[11px] text-text-muted cursor-pointer hover:text-text-primary">
                          <input
                            type="radio"
                            name={q.id}
                            value={opt}
                            checked={answers[q.id] === opt}
                            onChange={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                            className="accent-cyan"
                          />
                          {opt}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <Button
                  variant="primary"
                  icon={<Wand2 size={14} />}
                  loading={isGenerating}
                  onClick={() => handleGenerate()}
                  disabled={!concept.trim()}   /* the enclosing Card already hides when approved */
                >
                  Write Script
                </Button>
              </CardBody>
            </Card>
          )}

          {/* Item 1: load a custom script — file upload or paste-in */}
          <Card className="shrink-0">
            <CardBody className="flex flex-col gap-2">
              <label className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                <Upload size={10} className="inline mr-1" />Load Script
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.fountain,.md,text/plain"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileLoad(f); e.target.value = '' }}
              />
              <Button variant="ghost" size="sm" icon={<Upload size={12} />}
                onClick={() => fileInputRef.current?.click()}
                disabled={stage.status === 'approved'}
                data-testid="load-script-file">
                Upload .txt / .fountain / .md
              </Button>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="…or paste a script here"
                rows={3}
                disabled={stage.status === 'approved'}
                className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-[11px] font-mono text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/40 resize-none disabled:opacity-50"
                data-testid="paste-script"
              />
              <Button variant="primary" size="sm"
                onClick={() => { adoptScript(pasteText, 'pasted script'); setPasteText('') }}
                disabled={!pasteText.trim() || stage.status === 'approved'}
                data-testid="use-pasted-script">
                Use as Script
              </Button>
            </CardBody>
          </Card>

          {/* QC verdict + Approve/Regenerate live in the RIGHT column, next to the
              script they review — the narrow input column was too cramped for them. */}
        </div>

        {/* Right: the script + its review & actions — the wide, readable column. */}
        <div className="flex-1 min-w-0 flex flex-col gap-3 min-h-0">
          <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
            <FileText size={14} className="text-cyan" />
            <span className="text-xs font-semibold text-text-muted uppercase tracking-widest">
              Script
            </span>
            {isEdited && (
              <span className="px-1.5 py-0.5 rounded bg-amber/15 border border-amber/40 text-amber text-[9px] font-bold uppercase tracking-wider"
                data-testid="edited-badge">
                <PencilLine size={9} className="inline mr-0.5" />edited
              </span>
            )}
            {script && (
              <span className="ml-auto text-[10px] font-mono text-text-muted">
                {(draft ?? script).split(/\s+/).filter(Boolean).length} words
              </span>
            )}
            {/* Runtime against the target — the comparison IS the point, so it reads as
                a delta, in the same over/near/under colours Stage 2's badge uses. An
                offline estimate is the words/130 page rule and says so instead. */}
            {runtime && runtime.seconds > 0 && (() => {
              const over = runtime.seconds > targetDurationSecs * 1.15   // >15% over target
              const near = runtime.seconds > targetDurationSecs * 0.85   // within 15% either side
              const delta = runtime.seconds - targetDurationSecs
              return (
                <span
                  data-testid="script-runtime"
                  title={runtime.approx
                    ? 'Backend unreachable — rough words-per-minute page rule, which runs about 2× long on these scripts'
                    : `Dialogue ${secsLabel(runtime.dialogueSeconds)} + action ${secsLabel(runtime.actionSeconds)}`}
                  className={cn(
                    'px-1.5 py-0.5 rounded border text-[9px] font-mono font-bold',
                    runtime.approx ? 'bg-elevated border-border text-text-muted'
                      : over ? 'bg-red/15 border-red/40 text-red'
                      : near ? 'bg-green/15 border-green/40 text-green'
                      : 'bg-amber/15 border-amber/40 text-amber'
                  )}
                >
                  ≈ {secsLabel(runtime.seconds)} / {secsLabel(targetDurationSecs)}
                  <span className="font-normal opacity-70 ml-1">
                    {runtime.approx
                      ? 'approx'
                      : `${secsLabel(Math.abs(delta))} ${delta >= 0 ? 'over' : 'under'}`}
                  </span>
                </span>
              )
            })()}
            {draft !== null && draft !== script && (
              <Button variant="approve" size="sm" icon={<Save size={11} />}
                onClick={handleSaveEdits} data-testid="save-script-edits">
                Save Edits
              </Button>
            )}
          </div>
          <CardBody className="flex-1 overflow-hidden flex">
            {script || draft !== null ? (
              <textarea
                value={draft ?? script}
                onChange={(e) => setDraft(e.target.value)}
                disabled={stage.status === 'approved'}
                spellCheck={false}
                data-testid="script-editor"
                className="flex-1 w-full h-full bg-transparent text-sm text-text-primary font-mono whitespace-pre-wrap leading-relaxed resize-none focus:outline-none disabled:opacity-70"
              />
            ) : (
              <div className="flex items-center justify-center flex-1 text-text-muted text-sm">
                Enter a concept and click Generate — or load a script on the left
              </div>
            )}
          </CardBody>
          </Card>

          {/* Review & act — QC verdict + Approve/Regenerate, right next to the script
              they concern. Bounded + scrollable so it never crowds out the editor. */}
          {(isQcRunning || qcResult || errorMsg || stage.status !== 'idle') && (
            <div className="shrink-0 flex flex-col gap-3 max-h-[46%] overflow-y-auto pr-1" data-testid="script-review">
              {isQcRunning && <QCRunningCard context="Script" />}
              {qcResult && !isQcRunning && (
                <QCActionCard
                  qcResult={qcResult}
                  context="Script"
                  isRegenerating={isGenerating}
                  onRegenerate={(notes) => { setFeedback(''); handleGenerate(notes) }}
                />
              )}
              {errorMsg && (
                <div className="text-xs text-red bg-red/10 border border-red/30 rounded px-3 py-2">
                  {errorMsg}
                </div>
              )}
              {stage.status === 'approved' ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-green text-sm font-semibold px-2">
                    <CheckCircle size={15} /> Script approved
                  </div>
                  <Button variant="primary" onClick={() => goToStage(2)}>
                    Continue to Stage 2 →
                  </Button>
                </div>
              ) : stage.status !== 'idle' ? (
                <ApprovalControls
                  approveLabel="Approve Script"
                  onApprove={handleApprove}
                  onRegenerate={(fb) => { setFeedback(''); handleGenerate(fb) }}
                  canApprove={canApprove}
                  isGenerating={isGenerating || isQcRunning}
                  feedback={feedback}
                  onFeedbackChange={setFeedback}
                  qcPassed={qcResult ? qcResult.passed : null}
                  qcPersona={qcResult?.persona}
                />
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
