import { registerPlugin } from '@capacitor/core'
import { isNativeShell } from './nativeShell'

type OrionAudioNative = {
  enableLiveSpeaker: () => Promise<{ speaker?: boolean; mode?: string }>
  restoreAudio: () => Promise<void>
  setKeepLiveSession: (opts: { enable: boolean }) => Promise<void>
}

const OrionAudio = registerPlugin<OrionAudioNative>('OrionAudio')

let liveSpeakerArmed = false
let reassertTimer: number | null = null
let visibilityBound = false

function onVisibilityChange() {
  if (document.visibilityState === 'visible' && liveSpeakerArmed) {
    void OrionAudio.enableLiveSpeaker().catch(() => {})
  }
}

/** Force loudspeaker for live rooms (APK WebRTC otherwise uses quiet earpiece / in-call). */
export async function enableLiveRoomSpeaker(): Promise<void> {
  if (!isNativeShell()) return
  try {
    await OrionAudio.enableLiveSpeaker()
    liveSpeakerArmed = true
    armReassert()
    void OrionAudio.setKeepLiveSession({ enable: true }).catch(() => {})
  } catch (err) {
    console.warn('[OrionAudio] enableLiveSpeaker failed', err)
  }
}

/** Restore normal Android audio routing when leaving the room. */
export async function restoreRoomAudio(): Promise<void> {
  if (!isNativeShell()) return
  liveSpeakerArmed = false
  clearReassert()
  try {
    void OrionAudio.setKeepLiveSession({ enable: false }).catch(() => {})
    await OrionAudio.restoreAudio()
  } catch (err) {
    console.warn('[OrionAudio] restoreAudio failed', err)
  }
}

/** Pin WebView + screen-on while in a live (Home must not tear the mesh). */
export async function setNativeLiveKeepAlive(enable: boolean): Promise<void> {
  if (!isNativeShell()) return
  try {
    await OrionAudio.setKeepLiveSession({ enable })
  } catch {
    /* older APK without the method */
  }
}

function armReassert() {
  if (typeof window === 'undefined') return
  if (reassertTimer == null) {
    /* WebRTC / OEM stacks often steal the route after getUserMedia — re-pin speaker. */
    reassertTimer = window.setInterval(() => {
      if (!liveSpeakerArmed) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void OrionAudio.enableLiveSpeaker().catch(() => {})
    }, isNativeShell() ? 20_000 : 10_000)
  }
  if (!visibilityBound) {
    document.addEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = true
  }
}

function clearReassert() {
  if (reassertTimer != null) {
    window.clearInterval(reassertTimer)
    reassertTimer = null
  }
  if (visibilityBound) {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = false
  }
}
