import { useEffect, useState } from 'react'
import { isNativePowerSave, isDesktopLiveThrottle, roomUiPaused } from './roomPower'

let sharedCtx: AudioContext | null = null

export function getSharedAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioContext()
  }
  return sharedCtx
}

export function resumeSharedAudioContext() {
  const ctx = getSharedAudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
}

export function streamHasLiveAudio(stream: MediaStream | null, active = true) {
  if (!stream || !active) return false
  return stream.getAudioTracks().some((t) => t.enabled && t.readyState === 'live')
}

/** 0–100 level + talking flag from MediaStream audio (Web Audio — web/EXE/APK). */
export function useAudioLevel(stream: MediaStream | null, active = true) {
  const [level, setLevel] = useState(0)
  const [talking, setTalking] = useState(false)

  useEffect(() => {
    if (!streamHasLiveAudio(stream, active)) {
      setLevel(0)
      setTalking(false)
      return
    }

    let cancelled = false
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const ctx = getSharedAudioContext()
    void ctx.resume()

    const source = ctx.createMediaStreamSource(stream!)
    const analyser = ctx.createAnalyser()
    /* Smaller FFT on APK — less CPU per sample. */
    analyser.fftSize = isNativePowerSave() ? 256 : 512
    analyser.smoothingTimeConstant = 0.72
    analyser.minDecibels = -90
    analyser.maxDecibels = -10
    source.connect(analyser)

    const bins = new Uint8Array(analyser.frequencyBinCount)
    let lastTalking = false
    let lastLevelBucket = -1

    const sample = () => {
      if (cancelled) return
      if (roomUiPaused()) {
        /* App in background — stop painting meters; keep analyser idle. */
        schedule()
        return
      }
      analyser.getByteFrequencyData(bins)
      let sum = 0
      const voiceTop = Math.min(bins.length, 48)
      for (let i = 2; i < voiceTop; i += 1) sum += bins[i]
      const avg = sum / Math.max(1, voiceTop - 2) / 255
      const pct = Math.min(100, Math.round(avg * 165))
      const nextTalking = pct >= 14
      /* Bucket updates to cut React re-renders (biggest APK heat from N meters). */
      const bucket = Math.round(pct / (isNativePowerSave() ? 16 : 8))
      if (bucket !== lastLevelBucket || nextTalking !== lastTalking) {
        lastLevelBucket = bucket
        lastTalking = nextTalking
        setLevel(pct)
        setTalking(nextTalking)
      }
      schedule()
    }

    const schedule = () => {
      if (cancelled) return
      if (isNativePowerSave() || isDesktopLiveThrottle()) {
        /* ~8–12 Hz instead of 60fps rAF — meters stay, heat drops on EXE too. */
        timer = setTimeout(sample, roomUiPaused() ? 1200 : isNativePowerSave() ? 320 : 90)
      } else {
        raf = requestAnimationFrame(sample)
      }
    }

    schedule()

    const onTrackChange = () => {
      if (!streamHasLiveAudio(stream, active)) {
        setLevel(0)
        setTalking(false)
      }
    }
    stream!.addEventListener('addtrack', onTrackChange)
    stream!.addEventListener('removetrack', onTrackChange)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
      stream!.removeEventListener('addtrack', onTrackChange)
      stream!.removeEventListener('removetrack', onTrackChange)
      source.disconnect()
      analyser.disconnect()
    }
  }, [stream, active])

  return { level, talking }
}
