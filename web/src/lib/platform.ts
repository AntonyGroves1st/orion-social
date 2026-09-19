import { Capacitor } from '@capacitor/core'

export type OrionOs = 'windows' | 'mac' | 'linux' | 'android' | 'ios' | 'unknown'
export type OrionFormFactor = 'phone' | 'tablet' | 'desktop'
export type OrionShell = 'native-android' | 'native-ios' | 'desktop' | 'browser'

const TABLET_MIN_PX = 600
const DESKTOP_MIN_PX = 1024

let cachedOs: OrionOs | null = null
let cachedForm: OrionFormFactor | null = null
let cachedShell: OrionShell | null = null

function readUa(): string {
  if (typeof navigator === 'undefined') return ''
  return navigator.userAgent || ''
}

/** Host OS — works in browser, Capacitor WebView, and desktop launcher. */
export function getOrionOs(): OrionOs {
  if (cachedOs !== null) return cachedOs

  try {
    const cap = Capacitor.getPlatform()
    if (cap === 'android') {
      cachedOs = 'android'
      return cachedOs
    }
    if (cap === 'ios') {
      cachedOs = 'ios'
      return cachedOs
    }
  } catch {
    /* Capacitor not ready */
  }

  const ua = readUa()
  if (/Android/i.test(ua)) {
    cachedOs = 'android'
    return cachedOs
  }
  if (/iPhone|iPad|iPod/i.test(ua) || (/\bMac\b/.test(ua) && navigator.maxTouchPoints > 1)) {
    cachedOs = 'ios'
    return cachedOs
  }
  if (/Win(dows|32|64|NT)/i.test(ua) || /Windows/i.test(ua)) {
    cachedOs = 'windows'
    return cachedOs
  }
  if (/Macintosh|Mac OS X/i.test(ua)) {
    cachedOs = 'mac'
    return cachedOs
  }
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) {
    cachedOs = 'linux'
    return cachedOs
  }

  cachedOs = 'unknown'
  return cachedOs
}

export function isDesktopOs(): boolean {
  const os = getOrionOs()
  return os === 'windows' || os === 'mac' || os === 'linux'
}

export function isNativeMobile(): boolean {
  const shell = getOrionShell()
  return shell === 'native-android' || shell === 'native-ios'
}

/** True when served from the pkg desktop launcher (Windows EXE or Mac binary). */
export function isDesktopLauncher(): boolean {
  if (typeof document === 'undefined') return false
  if (document.documentElement.dataset.orionShell === 'desktop') return true
  const meta = document.querySelector('meta[name="orion-shell"]')
  return meta?.getAttribute('content') === 'desktop'
}

export function getOrionShell(): OrionShell {
  if (cachedShell !== null) return cachedShell

  try {
    if (Capacitor.isNativePlatform()) {
      cachedShell = Capacitor.getPlatform() === 'ios' ? 'native-ios' : 'native-android'
      return cachedShell
    }
    const cap = Capacitor.getPlatform()
    if (cap === 'android') {
      cachedShell = 'native-android'
      return cachedShell
    }
    if (cap === 'ios') {
      cachedShell = 'native-ios'
      return cachedShell
    }
  } catch {
    /* ignore */
  }

  if (typeof document !== 'undefined') {
    if (document.documentElement.classList.contains('orion-native')) {
      const os = getOrionOs()
      cachedShell = os === 'ios' ? 'native-ios' : 'native-android'
      return cachedShell
    }
    if (isDesktopLauncher()) {
      cachedShell = 'desktop'
      return cachedShell
    }
  }

  const ua = readUa()
  if (/;\s*wv\)/.test(ua) && /Android/i.test(ua)) {
    cachedShell = 'native-android'
    return cachedShell
  }

  cachedShell = 'browser'
  return cachedShell
}

/** Phone vs tablet vs desktop — uses shortest screen edge and touch hints. */
export function getFormFactor(): OrionFormFactor {
  if (cachedForm !== null) return cachedForm

  if (typeof window === 'undefined') {
    cachedForm = 'desktop'
    return cachedForm
  }

  const shell = getOrionShell()
  const minEdge = Math.min(window.innerWidth, window.innerHeight)
  const maxEdge = Math.max(window.innerWidth, window.innerHeight)

  if (shell === 'native-android' || shell === 'native-ios') {
    cachedForm = minEdge >= TABLET_MIN_PX && maxEdge >= 900 ? 'tablet' : 'phone'
    return cachedForm
  }

  if (isDesktopOs() && minEdge >= DESKTOP_MIN_PX) {
    cachedForm = 'desktop'
    return cachedForm
  }

  if (minEdge >= DESKTOP_MIN_PX && !isTouchPrimary()) {
    cachedForm = 'desktop'
    return cachedForm
  }

  if (minEdge >= TABLET_MIN_PX) {
    cachedForm = 'tablet'
    return cachedForm
  }

  cachedForm = 'phone'
  return cachedForm
}

export function isTouchPrimary(): boolean {
  if (typeof window === 'undefined') return false
  if (navigator.maxTouchPoints > 0) return true
  try {
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true
  } catch {
    /* ignore */
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** Adds OS / form-factor / shell classes for CSS targeting every device. */
export function markPlatformShell(): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  const body = document.body
  const os = getOrionOs()
  const form = getFormFactor()
  const shell = getOrionShell()

  root.dataset.orionOs = os
  root.dataset.orionForm = form
  root.dataset.orionShell = shell === 'desktop' ? 'desktop' : shell.startsWith('native') ? 'native' : 'browser'

  root.classList.add(`orion-os-${os}`)
  body?.classList.add(`orion-os-${os}`)

  root.classList.add(`orion-form-${form}`)
  body?.classList.add(`orion-form-${form}`)

  if (shell === 'native-android' || shell === 'native-ios') {
    root.classList.add('orion-native')
    body?.classList.add('orion-native')
    root.classList.add(shell === 'native-ios' ? 'orion-native-ios' : 'orion-native-android')
    body?.classList.add(shell === 'native-ios' ? 'orion-native-ios' : 'orion-native-android')
  }

  if (shell === 'desktop') {
    root.classList.add('orion-desktop')
    body?.classList.add('orion-desktop')
  }

  if (isTouchPrimary()) {
    root.classList.add('orion-touch')
    body?.classList.add('orion-touch')
  } else {
    root.classList.add('orion-pointer-fine')
    body?.classList.add('orion-pointer-fine')
  }

  if (isStandalonePwa()) {
    root.classList.add('orion-pwa')
    body?.classList.add('orion-pwa')
  }

  if (window.innerWidth <= 360) {
    root.classList.add('orion-narrow-phone')
    body?.classList.add('orion-narrow-phone')
  }
}

/** Re-run form-factor classes on resize / orientation (debounced by caller). */
export function refreshFormFactorClasses(): void {
  if (typeof document === 'undefined') return
  cachedForm = null
  const root = document.documentElement
  const body = document.body
  for (const cls of ['orion-form-phone', 'orion-form-tablet', 'orion-form-desktop', 'orion-narrow-phone']) {
    root.classList.remove(cls)
    body?.classList.remove(cls)
  }
  markPlatformShell()
}
