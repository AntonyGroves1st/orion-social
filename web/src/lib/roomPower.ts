import { Capacitor } from '@capacitor/core'

/**
 * Live-room power helpers — cut heat/CPU without dropping mesh or features.
 * Coalesce duplicate nudges; stagger heavy work so EXE/APK don't stampede.
 */

export function roomUiPaused(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'hidden'
}

export function isNativePowerSave(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/** Desktop EXE / Chrome in a live room — throttle, don't strip. */
export function isDesktopLiveThrottle(): boolean {
  return !isNativePowerSave()
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Coalesce work by key: rapid double-calls collapse into one delayed run.
 * Use for mesh nudge, media replay, stage refresh — keeps the system, drops stampede.
 */
export function scheduleRoomWork(key: string, fn: () => void, delayMs: number): void {
  const prev = pending.get(key)
  if (prev != null) clearTimeout(prev)
  const id = setTimeout(() => {
    pending.delete(key)
    if (roomUiPaused()) return
    try {
      fn()
    } catch (err) {
      console.warn(`[roomPower] ${key}`, err)
    }
  }, Math.max(0, delayMs))
  pending.set(key, id)
}

export function cancelRoomWork(key: string): void {
  const prev = pending.get(key)
  if (prev == null) return
  clearTimeout(prev)
  pending.delete(key)
}

export function cancelAllRoomWork(): void {
  for (const id of pending.values()) clearTimeout(id)
  pending.clear()
}

/** Interval ms for mesh watchdog (flush + heal light). */
export function meshWatchIntervalMs(): number {
  return isNativePowerSave() ? 14_000 : 5000
}

/** Global media replay safety-net (bind + play). */
export function mediaReplayIntervalMs(): number {
  return isNativePowerSave() ? 22_000 : 10000
}

/** Per-tile audio/video kick intervals (base — APK backs off when healthy). */
export function peerAudioKickMs(): number {
  return isNativePowerSave() ? 9000 : 4000
}

export function peerVideoKickMs(): number {
  return isNativePowerSave() ? 7000 : 3800
}

/** Max backoff for per-tile video kicks on APK when stream is already playing. */
export function peerVideoKickMaxMs(): number {
  return isNativePowerSave() ? 18_000 : 8000
}

/** Virtual BG canvas redraw period. */
export function virtualBgDrawMs(): number {
  return isNativePowerSave() ? 4000 : 1000
}

/** WebRTC signal poll — fast burst then steady (realtime channel handles most traffic). */
export function signalPollFastMs(): number {
  return isNativePowerSave() ? 900 : 500
}

export function signalPollFastDurationMs(): number {
  return isNativePowerSave() ? 12_000 : 25_000
}

export function signalPollSteadyMs(): number {
  return isNativePowerSave() ? 2500 : 800
}

/** Member/stage DB refresh — realtime covers joins; poll is a safety net. */
export function memberRefreshIntervalMs(): number {
  return isNativePowerSave() ? 6000 : 2500
}

/** Minimum gap between mesh renegotiations per peer (unless ICE failed). */
export function renogCooldownMs(): number {
  return isNativePowerSave() ? 20_000 : 10_000
}
