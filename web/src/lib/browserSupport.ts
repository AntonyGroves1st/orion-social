/** Browser quirks — Brave shields, Firefox video compositing, WebView, etc. */

import { isNativeShell } from './nativeShell'

let cachedBrave: boolean | null = null
let braveDetectPromise: Promise<boolean> | null = null

async function detectBraveAsync(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false

  const nav = navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> | boolean } }
  if (nav.brave?.isBrave) {
    try {
      const result = await Promise.resolve(nav.brave.isBrave())
      return !!result
    } catch {
      return true
    }
  }

  return /Brave/i.test(navigator.userAgent || '')
}

function runBraveDetect(): Promise<boolean> {
  if (!braveDetectPromise) {
    braveDetectPromise = detectBraveAsync().then((v) => {
      cachedBrave = v
      return v
    })
  }
  return braveDetectPromise
}

export function isBraveBrowser(): boolean {
  if (cachedBrave !== null) return cachedBrave
  if (typeof navigator === 'undefined') {
    cachedBrave = false
    return false
  }

  const nav = navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> | boolean } }
  if (nav.brave?.isBrave) {
    try {
      const result = nav.brave.isBrave()
      if (typeof result === 'boolean') {
        cachedBrave = result
        return result
      }
    } catch {
      /* async API — fall through */
    }
    /* API exists — treat as Brave until async probe finishes. */
    cachedBrave = true
    void runBraveDetect()
    return true
  }

  cachedBrave = /Brave/i.test(navigator.userAgent || '')
  return cachedBrave
}

/** Re-apply Brave classes after async `navigator.brave.isBrave()` resolves. */
export async function ensureBraveMarked(): Promise<boolean> {
  if (typeof document === 'undefined') return false
  const brave = await runBraveDetect()
  const root = document.documentElement
  const body = document.body
  if (brave) {
    root.classList.add('orion-brave')
    body?.classList.add('orion-brave')
    root.classList.remove('orion-chrome')
    body?.classList.remove('orion-chrome')
  } else {
    root.classList.remove('orion-brave')
    body?.classList.remove('orion-brave')
  }
  return brave
}

export function isFirefoxBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Firefox\//i.test(navigator.userAgent || '')
}

/** True when CSS transform/will-change or blend overlays on <video> often paint black. */
export function needsSafeVideoCompositing(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  /* Chrome desktop is included: mix-blend overlays + GPU video layers often hide cams. */
  return (
    /Firefox\//i.test(ua) ||
    /Edg\//i.test(ua) ||
    /Trident|MSIE/i.test(ua) ||
    /Chrome\//i.test(ua) ||
    /CriOS\//i.test(ua) ||
    isBraveBrowser()
  )
}

export function isChromeBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  /* Exclude Edge/Brave/Opera UA spoofs that still include Chrome/. */
  if (isBraveBrowser()) return false
  if (/Edg\//i.test(ua) || /OPR\//i.test(ua)) return false
  return /Chrome\//i.test(ua) || /CriOS\//i.test(ua)
}

export function markBrowserSupport(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const body = document.body
  if (isBraveBrowser()) {
    root.classList.add('orion-brave')
    body?.classList.add('orion-brave')
  }
  if (isFirefoxBrowser()) {
    root.classList.add('orion-firefox')
    body?.classList.add('orion-firefox')
  }
  if (isChromeBrowser()) {
    root.classList.add('orion-chrome')
    body?.classList.add('orion-chrome')
  }
  if (needsSafeVideoCompositing()) {
    root.classList.add('orion-safe-video')
    body?.classList.add('orion-safe-video')
  }
  if (!probeWebGL()) {
    root.classList.add('orion-no-webgl')
    body?.classList.add('orion-no-webgl')
  }
  void ensureBraveMarked().then((brave) => {
    if (brave && needsSafeVideoCompositing()) {
      root.classList.add('orion-safe-video')
      body?.classList.add('orion-safe-video')
    }
  })
}

let cachedWebGl: boolean | null = null

/** Brave Shields often disable WebGL — battle gift particles need a CSS fallback. */
export function probeWebGL(): boolean {
  if (cachedWebGl !== null) return cachedWebGl
  if (typeof document === 'undefined') {
    cachedWebGl = false
    return false
  }
  try {
    const canvas = document.createElement('canvas')
    cachedWebGl = !!(canvas.getContext('webgl') || canvas.getContext('webgl2'))
  } catch {
    cachedWebGl = false
  }
  return cachedWebGl
}

/** Prefer CSS gift FX when WebGL is blocked or on APK (Three.js + decode = heat). */
export function preferCssBattleFx(): boolean {
  if (isNativeShell()) return true
  return isBraveBrowser() || !probeWebGL()
}

/** Brave often blocks programmatic .click() on display:none file inputs. */
export function openFilePicker(input: HTMLInputElement | null): boolean {
  if (!input) return false
  try {
    input.click()
    return true
  } catch {
    /* fall through */
  }
  try {
    input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return true
  } catch {
    return false
  }
}
