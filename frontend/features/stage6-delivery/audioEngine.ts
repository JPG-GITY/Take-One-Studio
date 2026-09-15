'use client'

/**
 * Web Audio engine for the Stage 6 timeline preview. Decodes each audio clip once,
 * then schedules them on the AudioContext clock with sample-accurate gain
 * automation (smooth fade in/out) so multiple clips play in sync — far better than
 * ramping <audio>.volume at ~4 Hz. Also computes waveform peaks from the decoded
 * buffers (reused for the timeline waveform).
 */

export interface EngineClip {
  id: string
  url: string          // browser-loadable (served) URL — the decode key
  timelineStart: number
  inPoint: number
  outPoint: number
  volume: number
  fadeIn: number
  fadeOut: number
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private buffers = new Map<string, AudioBuffer>()
  private peaks = new Map<string, number[]>()
  private active: AudioBufferSourceNode[] = []
  private masterGain: GainNode | null = null   // master bus → mute + master volume in one place
  private muted = false
  private masterVol = 1     // 5K: master/bus gain (the DeliveryView master fader); mute overrides to 0

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctor()
      this.masterGain = this.ctx.createGain()
      this.masterGain.gain.value = this.muted ? 0 : this.masterVol
      this.masterGain.connect(this.ctx.destination)
    }
    return this.ctx
  }

  /** Mute/unmute the whole audio bus (the preview Mute button). Unmute restores the master level. */
  setMuted(m: boolean): void { this.muted = m; if (this.masterGain) this.masterGain.gain.value = m ? 0 : this.masterVol }

  /** 5K: set the master/bus gain (0 = silent, 1 = unity). Applied live unless muted. */
  setMasterVolume(v: number): void { this.masterVol = Math.max(0, v); if (this.masterGain && !this.muted) this.masterGain.gain.value = this.masterVol }

  /** Decode any not-yet-loaded clips + compute their peaks. Safe to call often.
   *  onPeaks is keyed by CLIP ID (multiple clips can share one source url). */
  async preload(clips: EngineClip[], onPeaks?: (clipId: string, peaks: number[]) => void): Promise<void> {
    const ctx = this.ensureCtx()
    await Promise.all(clips.map(async (c) => {
      if (this.buffers.has(c.url)) { if (onPeaks && this.peaks.has(c.url)) onPeaks(c.id, this.peaks.get(c.url)!); return }
      try {
        const res = await fetch(c.url)
        const arr = await res.arrayBuffer()
        const buf = await ctx.decodeAudioData(arr)
        this.buffers.set(c.url, buf)
        const pk = computePeaks(buf, 600)
        this.peaks.set(c.url, pk)
        onPeaks?.(c.id, pk)
      } catch { /* a clip that fails to decode just won't play in preview */ }
    }))
  }

  getPeaks(url: string): number[] | undefined { return this.peaks.get(url) }

  stop(): void {
    for (const s of this.active) { try { s.stop() } catch { /* already stopped */ } }
    this.active = []
  }

  /** (Re)schedule playback of all clips from a global playhead position. */
  async play(clips: EngineClip[], playhead: number): Promise<void> {
    const ctx = this.ensureCtx()
    if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /* */ } }
    this.stop()
    const now = ctx.currentTime
    for (const c of clips) {
      const buf = this.buffers.get(c.url)
      if (!buf) continue
      const dur = Math.max(0.01, c.outPoint - c.inPoint)
      const clipEnd = c.timelineStart + dur
      if (playhead >= clipEnd) continue
      const startGlobal = Math.max(playhead, c.timelineStart)
      const whenCtx = now + (startGlobal - playhead)
      const offset = c.inPoint + (startGlobal - c.timelineStart)
      const remaining = clipEnd - startGlobal
      const localStart = startGlobal - c.timelineStart

      const src = ctx.createBufferSource()
      src.buffer = buf
      const gain = ctx.createGain()
      src.connect(gain).connect(this.masterGain ?? ctx.destination)
      this.scheduleGain(gain.gain, c, whenCtx, localStart, dur)
      try { src.start(whenCtx, offset, remaining) } catch { continue }
      this.active.push(src)
    }
  }

  // Volume × fade-in/out envelope, anchored at whenCtx (which is local time
  // `localStart` into the clip). All ramps are scheduled on the ctx clock.
  private scheduleGain(p: AudioParam, c: EngineClip, whenCtx: number, localStart: number, dur: number): void {
    const vol = Math.max(0, c.volume)
    const fi = c.fadeIn, fo = c.fadeOut
    const at = (local: number) => whenCtx + (local - localStart)
    const factor = (local: number) => {
      let g = 1
      if (fi > 0 && local < fi) g = Math.min(g, local / fi)
      if (fo > 0 && dur - local < fo) g = Math.min(g, (dur - local) / fo)
      return Math.max(0, Math.min(1, g))
    }
    p.setValueAtTime(vol * factor(localStart), whenCtx)
    if (fi > 0 && localStart < fi) p.linearRampToValueAtTime(vol, at(fi))
    if (fo > 0) {
      const foStart = Math.max(localStart, dur - fo)
      p.setValueAtTime(vol, at(foStart))
      p.linearRampToValueAtTime(0, at(dur))
    }
  }

  dispose(): void { this.stop(); try { this.ctx?.close() } catch { /* */ } this.ctx = null }
}

/** Downsample an AudioBuffer to `count` normalized peak magnitudes (0–1). */
function computePeaks(buf: AudioBuffer, count: number): number[] {
  const ch = buf.getChannelData(0)
  const block = Math.max(1, Math.floor(ch.length / count))
  const out: number[] = []
  let max = 0.0001
  for (let i = 0; i < count; i++) {
    let peak = 0
    const start = i * block
    for (let j = 0; j < block && start + j < ch.length; j++) {
      const v = Math.abs(ch[start + j])
      if (v > peak) peak = v
    }
    out.push(peak)
    if (peak > max) max = peak
  }
  return out.map((v) => v / max)
}
