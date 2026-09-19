import { Capacitor } from '@capacitor/core'

/** How long a live heartbeat stays valid after Home / background (ms). */
export const LIVE_PRESENCE_GRACE_MS = 12 * 60_000

/**
 * APK: never leave the live when the user taps Home / switches apps.
 * Desktop tab close still leaves via beforeunload.
 */
export function shouldLeaveLiveOnPageHide(): boolean {
  try {
    return !Capacitor.isNativePlatform()
  } catch {
    return true
  }
}

/**
 * Keep the screen on while hosting/watching a live (WebView Wake Lock).
 * Best-effort — ignored if unsupported.
 */
export function acquireLiveWakeLock(): () => void {
  let lock: WakeLockSentinel | null = null
  let disposed = false

  const request = async () => {
    if (disposed) return
    try {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return
      lock = await navigator.wakeLock.request('screen')
      lock.addEventListener('release', () => {
        lock = null
      })
    } catch {
      /* unsupported / denied */
    }
  }

  void request()

  const onVis = () => {
    if (document.visibilityState === 'visible') void request()
  }
  document.addEventListener('visibilitychange', onVis)

  return () => {
    disposed = true
    document.removeEventListener('visibilitychange', onVis)
    try {
      void lock?.release()
    } catch {
      /* ignore */
    }
    lock = null
  }
}
