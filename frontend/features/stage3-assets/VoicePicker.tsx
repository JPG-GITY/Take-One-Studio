'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Volume2, Loader2, Play, Mic, Check, Image as ImageIcon, RotateCcw, AlertTriangle } from 'lucide-react'
import { pipelineApi, type VoiceConfig } from '@/lib/api/pipeline.api'
import { usePipelineStore } from '@/store/pipeline.store'

interface VoicePreset { id: string; label: string; speaker: string; pitch_rate: number; speech_rate: number }

const CLONE_EXTS = ['wav', 'mp3', 'pcm', 'ogg', 'opus']
const MAX_CLONE_BYTES = 10 * 1024 * 1024   // Seed Audio reference limit

/** Per-character voice lock (AG). The chosen config is persisted server-side
 *  (voice_anchors.json) and reused for every line this character speaks, so the
 *  voice stays identical across every shot. Two engines:
 *   - Seed TTS 2.0 preset voices (speaker + pitch/rate), or
 *   - Seed Audio 1.0 CLONE from an uploaded reference clip (same voice every line). */
export function VoicePicker({ character, portraitPath }: { character: string; portraitPath?: string }) {
  const { projectName, localFolderRoot } = usePipelineStore()
  const [presets, setPresets] = useState<VoicePreset[]>([])
  const [cfg, setCfg] = useState<VoiceConfig>({ speaker: '', pitch_rate: 0, speech_rate: 0, engine: 'seed_tts', ref_audio_path: '' })
  const [advanced, setAdvanced] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [cloneErr, setCloneErr] = useState('')
  const [previewErr, setPreviewErr] = useState('')
  // Name of the character whose last audition came back in a GENERIC voice (Seed Audio
  // rejected the reference), or ''. Held as STATE, not a toast: this is the panel where
  // the config is locked, and a toast is gone by the time the user locks — they would
  // lock a substitute voice believing they had heard the clone. Storing the NAME rather
  // than a bool means a different character can never inherit someone else's verdict.
  const [fellBackFor, setFellBackFor] = useState('')
  const [saved, setSaved] = useState<'idle' | 'saving' | 'done' | 'failed'>('idle')
  // Why the last lock did not reach disk, or ''. The catch below used to drop straight
  // back to 'idle', which on screen is identical to "nothing happened" — so a voice the
  // backend never persisted looked locked, and the character's next lines came out in a
  // different voice. Held next to the indicator, not as a toast, for the same reason
  // fellBackFor is: this is the panel where the user believes the voice was locked.
  const [saveErr, setSaveErr] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [cat, mine] = await Promise.all([
          pipelineApi.listVoices(),
          pipelineApi.getCharacterVoices(projectName, localFolderRoot ?? ''),
        ])
        if (!alive) return
        setPresets(cat.presets)
        const existing = mine.voices?.[character]
        setCfg(existing ?? { speaker: cat.base_voice, pitch_rate: 0, speech_rate: 0, engine: 'seed_tts', ref_audio_path: '' })
      } catch { /* backend may be old — leave defaults */ }
    })()
    return () => { alive = false }
  }, [character, projectName, localFolderRoot])

  const persist = useCallback(async (next: VoiceConfig, note?: string) => {
    setSaved('saving'); setSaveErr('')
    try {
      // Each save appends a version server-side (history + revert); pass the change note.
      const res = await pipelineApi.assignVoice(character, { ...next, ...(note ? { notes: note } : {}) } as VoiceConfig, projectName, localFolderRoot ?? '')
      setCfg(res.voice ?? next)
      setSaved('done'); setTimeout(() => setSaved('idle'), 1500)
    } catch (e) {
      // The backend no longer answers 200 for a lock it failed to write, so this branch
      // now means the voice really is NOT on disk. Say so and leave it said — sliding
      // back to 'idle' is what made a lost voice lock invisible.
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setCfg(next)
      setSaved('failed')
      setSaveErr(detail || 'Voice was not saved — try again')
    }
  }, [character, projectName, localFolderRoot])

  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id)
    // Choosing a preset switches back to the Seed TTS engine (the clip stays stored).
    if (p) persist({ ...cfg, speaker: p.speaker, pitch_rate: p.pitch_rate, speech_rate: p.speech_rate, engine: 'seed_tts' })
  }

  const designFromPortrait = () => {
    // New reference → the previous rejection verdict no longer describes anything.
    if (portraitPath) { setFellBackFor(''); persist({ ...cfg, engine: 'seed_audio_image', image_ref_path: portraitPath }, 'design from portrait') }
  }
  const revertTo = (v: NonNullable<VoiceConfig['versions']>[0]) =>
    persist({
      speaker: v.speaker ?? cfg.speaker, pitch_rate: v.pitch_rate ?? 0, speech_rate: v.speech_rate ?? 0,
      loudness_rate: v.loudness_rate ?? 0, engine: (v.engine as VoiceConfig['engine']) ?? 'seed_tts',
      ref_audio_path: v.ref_audio_path ?? '', image_ref_path: v.image_ref_path ?? '',
    }, `revert to ${new Date(v.createdAt).toLocaleTimeString()}`)

  const onCloneFile = async (file: File) => {
    setCloneErr('')
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (!CLONE_EXTS.includes(ext)) { setCloneErr('Use wav / mp3 / pcm / ogg'); return }
    if (file.size > MAX_CLONE_BYTES) { setCloneErr('Clip must be ≤ 10 MB'); return }
    setCloning(true)
    try {
      const dataUri: string = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(r.error)
        r.readAsDataURL(file)
      })
      const res = await pipelineApi.uploadVoiceReference(character, dataUri, ext, projectName, localFolderRoot ?? '')
      setCfg(res.voice)   // now engine=seed_audio with ref_audio_path
      setFellBackFor('') // a fresh clip has not been auditioned (let alone rejected) yet
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : 'Upload failed')
    } finally { setCloning(false) }
  }

  const preview = async () => {
    setPreviewing(true)
    setPreviewErr('')
    setFellBackFor('')   // show this audition's verdict, never the previous one's
    try {
      const { audio_b64, voice_fallback } = await pipelineApi.previewVoice(cfg, `Hello, I am ${character}. This is my voice.`)
      if (!audioRef.current) audioRef.current = new Audio()
      audioRef.current.src = audio_b64
      // Set BEFORE play() so the warning is already on screen while the clip is heard —
      // and it stays there until the next audition, i.e. through the lock.
      setFellBackFor(voice_fallback ? character : '')
      await audioRef.current.play()
    } catch (e) {
      // Was swallowed: pressing Preview and hearing nothing looked identical to a
      // voice that simply had not loaded. Say which it was.
      setPreviewErr(e instanceof Error ? e.message : 'Preview failed')
    } finally { setPreviewing(false) }
  }

  const isClone = cfg.engine === 'seed_audio' && !!cfg.ref_audio_path
  const isDesign = cfg.engine === 'seed_audio_image' && !!cfg.image_ref_path
  const isSeedAudio = isClone || isDesign
  const versions = cfg.versions ?? []
  // which preset (if any) matches the current config
  const activePreset = presets.find(
    (p) => p.speaker === cfg.speaker && p.pitch_rate === cfg.pitch_rate && p.speech_rate === cfg.speech_rate,
  )?.id ?? 'custom'

  return (
    <div className="mt-2 rounded-md border border-border bg-elevated/40 p-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Volume2 size={13} className="text-cyan shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Voice lock</span>
        {saved === 'saving' && <Loader2 size={10} className="animate-spin text-text-dim" />}
        {saved === 'done' && <span className="text-[9px] text-green">saved</span>}
        {saved === 'failed' && <span className="text-[9px] text-red font-semibold">NOT saved</span>}
        <button
          onClick={preview}
          disabled={previewing}
          className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-cyan/10 text-cyan border border-cyan/40 hover:bg-cyan/20 disabled:opacity-50"
        >
          {previewing ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
          Preview
        </button>
      </div>

      {/* The audition lied: Seed Audio rejected the reference and answered in a generic
          voice. This sits directly under the Preview button and survives until the next
          audition — the whole point is that it is still on screen when the config is
          locked, because locking it locks the SUBSTITUTE, not this character's voice. */}
      {!!fellBackFor && fellBackFor === character && isSeedAudio && (
        <div className="flex items-start gap-2 rounded bg-red/10 border border-red/40 px-2 py-1.5" data-testid="voice-fallback-warning">
          <AlertTriangle size={11} className="text-red shrink-0 mt-px" />
          <span className="text-[10px] text-red leading-relaxed">
            <span className="font-semibold">That is NOT {character}&apos;s voice.</span>{' '}
            Seed Audio rejected the {isClone ? 'reference clip' : 'portrait'} and spoke the audition
            in a generic substitute. Locking this config locks the substitute — replace the{' '}
            {isClone ? 'clip' : 'portrait'} and preview again before you move on.
          </span>
        </div>
      )}
      {previewErr && <span className="text-[9px] text-red">Preview failed: {previewErr}</span>}

      {isSeedAudio ? (
        <div className="flex items-center gap-2 rounded bg-cyan/10 border border-cyan/40 px-2 py-1">
          <Check size={11} className="text-cyan shrink-0" />
          <span className="text-[10px] text-cyan font-semibold">
            {isClone ? 'Cloned voice — Seed Audio 1.0' : 'Voice from portrait — Seed Audio 1.0'}
          </span>
          <button
            onClick={() => persist({ ...cfg, engine: 'seed_tts' })}
            className="ml-auto text-[9px] text-text-muted hover:text-text-primary"
          >
            Use preset instead
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <select
            value={activePreset}
            onChange={(e) => e.target.value !== 'custom' && applyPreset(e.target.value)}
            className="flex-1 bg-surface border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-cyan/50"
          >
            {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            <option value="custom">Custom…</option>
          </select>
        </div>
      )}

      {/* Clone from a reference clip → consistent voice per actor (Seed Audio 1.0) */}
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".wav,.mp3,.pcm,.ogg,.opus,audio/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onCloneFile(f); e.target.value = '' }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={cloning}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-surface border border-border text-text-muted hover:text-text-primary hover:border-cyan/50 disabled:opacity-50"
        >
          {cloning ? <Loader2 size={10} className="animate-spin" /> : <Mic size={10} />}
          {isClone ? 'Replace reference clip' : 'Clone from clip'}
        </button>
        {portraitPath && (
          <button
            onClick={designFromPortrait}
            title="Infer a voice from this character's approved portrait (Seed Audio 1.0)"
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-surface border border-border text-text-muted hover:text-text-primary hover:border-cyan/50"
          >
            <ImageIcon size={10} /> {isDesign ? 'Re-derive from portrait' : 'Design from portrait'}
          </button>
        )}
        <span className="text-[9px] text-text-dim">clip ≤ 30 s, ≤ 10 MB</span>
      </div>
      {cloneErr && <span className="text-[9px] text-red">{cloneErr}</span>}
      {saveErr && (
        <span className="flex items-start gap-1 text-[9px] text-red">
          <AlertTriangle size={10} className="shrink-0 mt-px" /> {saveErr}
        </span>
      )}

      <button onClick={() => setAdvanced((v) => !v)} className="self-start text-[9px] text-text-muted hover:text-text-primary">
        {advanced ? '− Hide tuning' : '+ Tune (pitch / speed / loudness)'}
      </button>
      {advanced && (
        <div className="flex flex-col gap-2 pt-1">
          {!isSeedAudio && (
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] text-text-dim">Speaker ID (override — paste a voice from your BytePlus console)</span>
              <input
                value={cfg.speaker}
                onChange={(e) => setCfg({ ...cfg, speaker: e.target.value })}
                onBlur={() => persist(cfg)}
                className="bg-surface border border-border rounded px-2 py-1 text-[10px] font-mono text-text-primary focus:outline-none focus:border-cyan/50"
              />
            </label>
          )}
          <label className="flex items-center gap-2">
            <span className="text-[9px] text-text-dim w-20 shrink-0">Pitch {cfg.pitch_rate > 0 ? '+' : ''}{cfg.pitch_rate}</span>
            <input type="range" min={-12} max={12} value={cfg.pitch_rate}
              onChange={(e) => setCfg({ ...cfg, pitch_rate: Number(e.target.value) })}
              onMouseUp={() => persist(cfg)} onTouchEnd={() => persist(cfg)}
              className="flex-1 accent-cyan" />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[9px] text-text-dim w-20 shrink-0">Speed {cfg.speech_rate > 0 ? '+' : ''}{cfg.speech_rate}</span>
            <input type="range" min={-50} max={100} value={cfg.speech_rate}
              onChange={(e) => setCfg({ ...cfg, speech_rate: Number(e.target.value) })}
              onMouseUp={() => persist(cfg)} onTouchEnd={() => persist(cfg)}
              className="flex-1 accent-cyan" />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[9px] text-text-dim w-20 shrink-0">Loudness {(cfg.loudness_rate ?? 0) > 0 ? '+' : ''}{cfg.loudness_rate ?? 0}</span>
            <input type="range" min={-50} max={100} value={cfg.loudness_rate ?? 0}
              onChange={(e) => setCfg({ ...cfg, loudness_rate: Number(e.target.value) })}
              onMouseUp={() => persist(cfg)} onTouchEnd={() => persist(cfg)}
              className="flex-1 accent-cyan" />
          </label>
        </div>
      )}

      {versions.length > 1 && (
        <div className="flex flex-col gap-1 pt-1 border-t border-border/50">
          <span className="text-[9px] font-semibold text-text-dim uppercase tracking-wider">History ({versions.length})</span>
          {versions.slice().reverse().slice(0, 5).map((v) => (
            <div key={v.id} className="flex items-center gap-1.5 text-[9px] text-text-muted">
              <span className={cfg.selectedVersionId === v.id ? 'text-cyan' : ''}>
                {v.engine === 'seed_audio' ? 'clone' : v.engine === 'seed_audio_image' ? 'portrait' : 'preset'}
                {v.notes ? ` · ${v.notes}` : ''} · {new Date(v.createdAt).toLocaleTimeString()}
              </span>
              {cfg.selectedVersionId !== v.id && (
                <button onClick={() => revertTo(v)} title="Revert to this voice" className="ml-auto text-text-dim hover:text-cyan">
                  <RotateCcw size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
