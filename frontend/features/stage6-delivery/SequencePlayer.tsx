'use client'

/**
 * Double-buffered sequence player for Stage 6. Two <video> elements: one plays the
 * current clip while the other PRELOADS the next, so advancing across a cut is
 * seamless (no reload pause). Native controls are hidden (they flashed on every
 * clip swap) — the parent drives transport (play/seek/mute/fullscreen) via the
 * handle and is told when playback advances or the playhead moves.
 */

import { forwardRef, useImperativeHandle, useRef, useEffect, useCallback, useMemo } from 'react'
import { cn } from '@/lib/utils'

export interface SeqClip {
  shotId: string
  url: string
  inPoint: number
  duration: number   // trimmed duration
  volume: number     // per-clip audio gain (0–1+)
  fadeIn: number     // seconds — video fades from black
  fadeOut: number    // seconds — video fades to black
}

// 5C: a positioned V2 overlay clip the player composites ON TOP of the base track.
export interface OverlaySeqClip {
  shotId: string
  url: string
  timelineStart: number   // where it sits on the global timeline (s)
  inPoint: number
  duration: number        // trimmed (outPoint - inPoint)
  volume: number
  fadeIn: number
  fadeOut: number
}

export interface SequencePlayerHandle {
  /** Seek to a global timeline position (seconds) — switches clips if needed. */
  seek: (globalSeconds: number) => void
  play: () => void
  pause: () => void
  setMuted: (muted: boolean) => void
  requestFullscreen: () => void
}

interface SequencePlayerProps {
  clips: SeqClip[]
  offsets: number[]                       // global start (s) of each clip, parallel to clips
  onTime: (globalSeconds: number) => void
  onActiveIndexChange: (index: number) => void
  onPlayingChange?: (playing: boolean) => void
  masterVolume?: number                   // 5K: global master gain multiplied into each clip's per-clip volume
  overlays?: OverlaySeqClip[]             // 5C: V2 overlay clips composited on top of the base track
}

export const SequencePlayer = forwardRef<SequencePlayerHandle, SequencePlayerProps>(
  function SequencePlayer({ clips, offsets, onTime, onActiveIndexChange, onPlayingChange, masterVolume = 1, overlays = [] }, ref) {
    const vid0 = useRef<HTMLVideoElement>(null)
    const vid1 = useRef<HTMLVideoElement>(null)
    const vid = useMemo(() => [vid0, vid1] as const, [])
    const containerRef = useRef<HTMLDivElement>(null)
    const mutedRef = useRef(false)
    const rafRef = useRef<number | null>(null)            // fade-overlay animation frame
    const clipsRef = useRef(clips); clipsRef.current = clips   // latest clips for the self-rescheduling rAF loop
    const front = useRef<0 | 1>(0)                     // which physical element is visible
    const bufClip = useRef<[number, number]>([-1, -1]) // clip index loaded in each buffer
    const activeClip = useRef(0)
    const playingRef = useRef(false)   // 5H: single source of truth for playback intent — NOT per-buffer play/pause events (which are front-gated and get swallowed after a swap/edit)
    const fadeOverlay = useRef<HTMLDivElement>(null)   // black overlay for video fade in/out
    // Keep the latest callbacks in refs so effects/handlers don't churn on their
    // identity (the parent passes inline arrows) and cause re-render loops.
    const onTimeRef = useRef(onTime); onTimeRef.current = onTime
    const onIdxRef = useRef(onActiveIndexChange); onIdxRef.current = onActiveIndexChange
    const onPlayingRef = useRef(onPlayingChange); onPlayingRef.current = onPlayingChange
    const masterRef = useRef(masterVolume); masterRef.current = masterVolume   // 5K: latest master gain for the clip-switch path
    // 5C: V2 overlay compositing — a 3rd <video> layered above the double buffers.
    const overlayVid = useRef<HTMLVideoElement>(null)
    const overlaysRef = useRef(overlays); overlaysRef.current = overlays
    const offsetsRef = useRef(offsets); offsetsRef.current = offsets   // read via ref so the rAF loop's deps stay stable
    const activeOverlay = useRef(-1)

    const clipAt = useCallback((i: number) => clips[i], [clips])
    // 5H: structural signature (identity + source of each clip). Trims only change
    // inPoint/duration/volume/fade and must NOT reset the double buffer, so they are
    // excluded — only a changed clip count/order or a clip's url (edit/insert/reorder/
    // delete) changes this string and triggers a reset. `clips` itself is a fresh array
    // every render (parent re-maps it on every ~4 Hz onTime tick), so we must key the
    // reset effect on the STRING, not the array ref.
    const structSig = useMemo(() => clips.map((c) => `${c.shotId}|${c.url}`).join('~'), [clips])
    const sigRef = useRef('')

    // Load a clip into a buffer (only re-sets src when it changes), seeking to its
    // inPoint once metadata is ready.
    const loadBuffer = useCallback((buf: 0 | 1, clipIndex: number) => {
      const el = vid[buf].current
      const clip = clipAt(clipIndex)
      if (!el || !clip) return
      if (el.dataset.url !== clip.url) {
        bufClip.current[buf] = clipIndex
        el.dataset.url = clip.url
        el.src = clip.url
        el.load()
        const onMeta = () => { try { el.currentTime = clip.inPoint } catch { /* */ } el.removeEventListener('loadedmetadata', onMeta) }
        el.addEventListener('loadedmetadata', onMeta)
      } else {
        bufClip.current[buf] = clipIndex
      }
    }, [vid, clipAt])

    const showFront = useCallback(() => {
      const f = front.current
      vid[f].current?.classList.remove('opacity-0', 'pointer-events-none')
      vid[f].current?.classList.add('opacity-100')
      vid[1 - f].current?.classList.add('opacity-0', 'pointer-events-none')
      vid[1 - f].current?.classList.remove('opacity-100')
    }, [vid])

    // Make `clipIndex` the active (front) clip, seek + (optionally) play, and
    // preload the NEXT clip into the back buffer.
    const activate = useCallback((clipIndex: number, localSeconds: number, play: boolean) => {
      if (clipIndex < 0 || clipIndex >= clips.length) return
      const back: 0 | 1 = (1 - front.current) as 0 | 1
      const clipUrl = clipAt(clipIndex)?.url
      // If the back buffer already preloaded this clip, swap to it (seamless).
      if (vid[back].current?.dataset.url === clipUrl && clipUrl) {
        front.current = back
      } else {
        loadBuffer(front.current, clipIndex)
      }
      activeClip.current = clipIndex
      const f = front.current
      const el = vid[f].current
      const clip = clipAt(clipIndex)
      if (el && clip) {
        el.volume = Math.max(0, Math.min(1, (clip.volume ?? 1) * masterRef.current))
        el.muted = mutedRef.current
        const apply = () => { try { el.currentTime = clip.inPoint + localSeconds } catch { /* */ } if (play) el.play().catch(() => {}) }
        if (el.readyState >= 1) apply()
        else { const h = () => { apply(); el.removeEventListener('loadedmetadata', h) }; el.addEventListener('loadedmetadata', h) }
      }
      showFront()
      loadBuffer((1 - f) as 0 | 1, clipIndex + 1)   // preload the next clip
      onIdxRef.current(clipIndex)
    }, [clips.length, vid, clipAt, loadBuffer, showFront])

    const advanceFrom = useCallback((buf: 0 | 1) => {
      if (buf !== front.current) return
      const next = activeClip.current + 1
      if (next < clips.length) { activate(next, 0, true); return }
      // End of sequence: STOP cleanly and tell the parent playback ended. Without this the
      // last clip just `ended`, playingRef/`playing` stuck TRUE with nothing rendering, so the
      // transport button wedged on Pause and couldn't stop/replay (comment above, 2026-07-23).
      playingRef.current = false
      onPlayingRef.current?.(false)
      vid[front.current].current?.pause()
      overlayVid.current?.pause()
    }, [clips.length, activate, vid])

    useImperativeHandle(ref, () => ({
      seek: (globalSeconds: number) => {
        let i = 0
        while (i < clips.length - 1 && globalSeconds >= offsets[i] + (clips[i]?.duration ?? 0)) i++
        const local = Math.max(0, globalSeconds - (offsets[i] ?? 0))
        if (i === activeClip.current) {
          const el = vid[front.current].current
          const clip = clipAt(i)
          if (el && clip) el.currentTime = clip.inPoint + local
          onTimeRef.current(globalSeconds)
        } else {
          activate(i, local, playingRef.current)   // 5H: keep-playing from intent, not a possibly-stale element's .paused
        }
      },
      play: () => { playingRef.current = true; onPlayingRef.current?.(true); vid[front.current].current?.play().catch(() => {}) },
      pause: () => { playingRef.current = false; onPlayingRef.current?.(false); vid[front.current].current?.pause(); overlayVid.current?.pause() },   // 5C: pause the V2 overlay too
      setMuted: (m: boolean) => { mutedRef.current = m; if (vid[0].current) vid[0].current.muted = m; if (vid[1].current) vid[1].current.muted = m },
      requestFullscreen: () => { containerRef.current?.requestFullscreen?.().catch(() => {}) },
    }), [clips, offsets, vid, clipAt, activate])

    // Initial load + STRUCTURAL reset (5H). Fires only when structSig changes (clip
    // count/order/url) — NOT on every re-render. On a structural change the double-buffer
    // bookkeeping (front/bufClip/activeClip) can point at a swapped-away or reloaded
    // <video>, so per-buffer play/pause/ended desync and `playing` sticks true with
    // nothing rendering (Play then no-ops = wedged). Reset to a deterministic state
    // (front = buffer 0, holding the active clip), re-derive the active index from the
    // clip array, reload+preload, then re-assert playback from the single source of truth.
    useEffect(() => {
      const firstMount = sigRef.current === ''
      sigRef.current = structSig
      if (clips.length === 0) return
      const idx = Math.min(Math.max(0, activeClip.current), clips.length - 1)
      front.current = 0
      bufClip.current = [-1, -1]
      activeClip.current = idx
      loadBuffer(0, idx)                     // guarded: reloads + seeks inPoint only if buffer 0's url differs
      loadBuffer(1, idx + 1)                 // preload the next clip
      showFront()
      onIdxRef.current(idx)
      // Re-assert intent: if the user was playing, resume the (possibly reloaded) front
      // buffer so an edit/insert/reorder mid-play never leaves `playing` true with a dead
      // transport. Skip on first mount (nothing was playing yet).
      if (!firstMount && playingRef.current) {
        const el = vid[0].current
        const clip = clips[idx]
        if (el && clip) {
          const resume = () => { el.play().catch(() => {}) }
          if (el.readyState >= 1) resume()
          else { const h = () => { resume(); el.removeEventListener('loadedmetadata', h) }; el.addEventListener('loadedmetadata', h) }
        }
      }
    }, [structSig])   // eslint-disable-line react-hooks/exhaustive-deps -- fire ONLY on a structural change; loadBuffer/showFront are read via the fresh render closure

    // Live per-clip volume (the timeline handle can change it during playback)
    // and the master fader (5K) — re-applies when either changes.
    useEffect(() => {
      const el = vid[front.current].current
      const clip = clips[activeClip.current]
      if (el && clip) el.volume = Math.max(0, Math.min(1, (clip.volume ?? 1) * masterVolume))
    }, [clips, vid, masterVolume])

    // 5C: composite the V2 overlay covering `globalTime` on top of the base track.
    // Show/seek/fade/volume the overlay <video>; MUTE the base under it (top layer's
    // audio wins, matching the ffmpeg render ducking); restore the base + hide the
    // overlay when nothing covers. Reads live values via refs so its deps stay [vid].
    const syncOverlay = useCallback((globalTime: number, shouldPlay: boolean) => {
      const ov = overlayVid.current
      if (!ov) return
      const list = overlaysRef.current
      const base = vid[front.current].current
      let idx = -1
      for (let i = 0; i < list.length; i++) {
        const o = list[i]
        if (globalTime >= o.timelineStart && globalTime < o.timelineStart + o.duration) { idx = i; break }
      }
      if (idx === -1) {
        if (activeOverlay.current !== -1) {
          ov.pause()
          ov.classList.add('opacity-0', 'pointer-events-none')
          if (base) base.muted = mutedRef.current   // restore base audio
          activeOverlay.current = -1
        }
        return
      }
      const o = list[idx]
      const local = globalTime - o.timelineStart
      if (activeOverlay.current !== idx) {
        if (ov.dataset.url !== o.url) { ov.src = o.url; ov.dataset.url = o.url }
        activeOverlay.current = idx
      }
      const target = o.inPoint + local
      if (Math.abs(ov.currentTime - target) > 0.3) { try { ov.currentTime = target } catch { /* not seekable yet */ } }
      ov.classList.remove('opacity-0', 'pointer-events-none')
      ov.volume = Math.max(0, Math.min(1, (o.volume ?? 1) * masterRef.current))
      ov.muted = mutedRef.current
      if (base) base.muted = true                    // top layer wins the audio
      // own fade in/out via opacity (dissolve over V1)
      let g = 1
      if (o.fadeIn > 0 && local < o.fadeIn) g = local / o.fadeIn
      if (o.fadeOut > 0 && o.duration - local < o.fadeOut) g = Math.min(g, (o.duration - local) / o.fadeOut)
      ov.style.opacity = String(Math.max(0, Math.min(1, g)))
      if (shouldPlay && ov.paused) ov.play().catch(() => {})
      else if (!shouldPlay && !ov.paused) ov.pause()
    }, [vid])

    // Black-overlay opacity for the active clip's fade in/out at the LIVE playhead
    // (1 = full black). `timeupdate` only fires ~4 Hz, so reading it there made the
    // fade visibly stepped; we drive this from rAF (~60 fps) while playing instead.
    const applyFadeOverlay = useCallback(() => {
      const el = vid[front.current].current
      const clip = clipsRef.current[activeClip.current]
      if (!el || !clip || !fadeOverlay.current) return
      const local = Math.min(clip.duration, Math.max(0, el.currentTime - clip.inPoint))
      let g = 1
      if (clip.fadeIn > 0 && local < clip.fadeIn) g = local / clip.fadeIn
      if (clip.fadeOut > 0 && clip.duration - local < clip.fadeOut) g = Math.min(g, (clip.duration - local) / clip.fadeOut)
      fadeOverlay.current.style.opacity = String(1 - Math.max(0, Math.min(1, g)))
    }, [vid])

    const stopFadeLoop = useCallback(() => { if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }, [])
    const fadeLoop = useCallback(() => {
      applyFadeOverlay()
      // 5C: drive V2 overlay sync at ~60fps while playing (offsets via ref → stable deps).
      const el = vid[front.current].current
      const clip = clipsRef.current[activeClip.current]
      if (el && clip) {
        const local = Math.min(clip.duration, Math.max(0, el.currentTime - clip.inPoint))
        syncOverlay((offsetsRef.current[activeClip.current] ?? 0) + local, !el.paused)
      }
      rafRef.current = requestAnimationFrame(fadeLoop)
    }, [applyFadeOverlay, syncOverlay, vid])
    const startFadeLoop = useCallback(() => { if (rafRef.current == null) rafRef.current = requestAnimationFrame(fadeLoop) }, [fadeLoop])
    useEffect(() => () => stopFadeLoop(), [stopFadeLoop])   // cancel on unmount

    const handleTimeUpdate = (buf: 0 | 1) => () => {
      if (buf !== front.current) return
      const el = vid[buf].current
      const clip = clipAt(activeClip.current)
      if (!el || !clip) return
      const local = Math.min(clip.duration, Math.max(0, el.currentTime - clip.inPoint))
      const globalT = (offsets[activeClip.current] ?? 0) + local
      onTimeRef.current(globalT)
      applyFadeOverlay()   // keeps the overlay correct while paused / scrubbing too
      syncOverlay(globalT, !el.paused)   // 5C
      // Trimmed clips: stop at outPoint and advance early.
      if (el.currentTime >= clip.inPoint + clip.duration - 0.05) advanceFrom(buf)
    }

    const handleEnded = (buf: 0 | 1) => () => {
      if (buf !== front.current) return
      const atEnd = activeClip.current + 1 >= clips.length
      advanceFrom(buf)
      if (atEnd) { stopFadeLoop(); applyFadeOverlay(); overlayVid.current?.pause(); playingRef.current = false; onPlayingRef.current?.(false) }   // 5H: end-of-sequence is the ONE legitimate auto-stop (5C: stop the overlay too)
    }
    // 5H: no onPlayingChange here — intent is owned by play()/pause()/end-of-sequence.
    // Auto-advance re-fires onPlay but `playing` is already true; a transient element
    // pause (buffer reload/swap) must NOT flip `playing` false.
    const handlePlay = (buf: 0 | 1) => () => { if (buf === front.current) startFadeLoop() }
    const handlePause = (buf: 0 | 1) => () => { if (buf === front.current) { stopFadeLoop(); applyFadeOverlay() } }

    if (clips.length === 0) {
      return <div className="w-full h-full bg-black" />
    }

    return (
      <div ref={containerRef} className="relative w-full h-full bg-black">
        {[0, 1].map((b) => (
          <video
            key={b}
            ref={vid[b as 0 | 1]}
            playsInline
            preload="auto"
            onTimeUpdate={handleTimeUpdate(b as 0 | 1)}
            onEnded={handleEnded(b as 0 | 1)}
            onPlay={handlePlay(b as 0 | 1)}
            onPause={handlePause(b as 0 | 1)}
            className={cn(
              // Instant swap (no opacity fade) — a cross-fade revealed the black
              // background between clips. The incoming buffer's inPoint frame is
              // already decoded (currentTime set on preload), so it shows at once.
              'absolute inset-0 m-auto max-h-full max-w-full object-contain',
              b === 0 ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
          />
        ))}
        {/* 5C: V2 overlay layer — above the double buffers (z-10), below the black fade
            overlay (z-20). Hidden until syncOverlay reveals it for a covering overlay. */}
        <video
          ref={overlayVid}
          playsInline
          preload="auto"
          className="absolute inset-0 m-auto max-h-full max-w-full object-contain z-10 opacity-0 pointer-events-none"
        />
        {/* Video fade in/out overlay */}
        <div ref={fadeOverlay} className="absolute inset-0 bg-black pointer-events-none z-20" style={{ opacity: 0 }} />
      </div>
    )
  },
)
