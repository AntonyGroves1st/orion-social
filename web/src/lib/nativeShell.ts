import { Capacitor } from '@capacitor/core'
import { getOrionShell, isNativeMobile, markPlatformShell } from './platform'

let cachedNative: boolean | null = null

/** True when running inside Capacitor (Android APK or iOS app), not mobile browser. */
export function isNativeShell(): boolean {
  if (cachedNative !== null) return cachedNative
  if (typeof window === 'undefined') {
    cachedNative = false
    return false
  }

  if (isNativeMobile()) {
    cachedNative = true
    return true
  }

  try {
    if (Capacitor.isNativePlatform()) {
      cachedNative = true
      return true
    }
    const platform = Capacitor.getPlatform()
    if (platform === 'android' || platform === 'ios') {
      cachedNative = true
      return true
    }
  } catch {
    /* Capacitor not ready */
  }

  if (document.documentElement.classList.contains('orion-native')) {
    cachedNative = true
    return true
  }

  const ua = navigator.userAgent || ''
  if (/;\s*wv\)/.test(ua) && /Android/i.test(ua)) {
    cachedNative = true
    return true
  }
  if (/Capacitor/i.test(ua)) {
    cachedNative = true
    return true
  }

  cachedNative = false
  return false
}

export function markNativeShell(): void {
  if (typeof document === 'undefined') return
  markPlatformShell()
  if (!isNativeShell()) return
  document.documentElement.classList.add('orion-native')
  document.body?.classList.add('orion-native')
  const shell = getOrionShell()
  if (shell === 'native-ios') {
    document.documentElement.classList.add('orion-native-ios')
    document.body?.classList.add('orion-native-ios')
  } else if (shell === 'native-android') {
    document.documentElement.classList.add('orion-native-android')
    document.body?.classList.add('orion-native-android')
  }
}

/** APK uses phone-style footer; EXE/web use the wider studio compact breakpoint. */
export const LIVE_ROOM_MOBILE_FOOTER_PX = 720
export const LIVE_ROOM_COMPACT_CHROME_PX = 899

export function getLiveRoomCompactMaxWidthPx(): number {
  return isNativeShell() ? LIVE_ROOM_MOBILE_FOOTER_PX : LIVE_ROOM_COMPACT_CHROME_PX
}

export function shouldUseMobileRoomFooter(viewportNarrow: boolean): boolean {
  return isNativeShell() || viewportNarrow
}
