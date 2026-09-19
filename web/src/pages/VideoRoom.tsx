import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import type { Profile } from '../lib/supabase'
import { supabase } from '../lib/supabase'
import BattleModePanel, {
  ROYALE_COLORS,
  type BattleCameraHit,
  type BattleLeagueRow,
} from '../components/BattleModePanel'
import BattleThreeEffect from '../components/BattleThreeEffect'
import { attachRoomLayoutSync } from '../lib/roomBattleSync'
import type { HostMuteSync, RoomLayoutSync } from '../lib/roomBattleSync'
import {
  canAdminLiveStage,
  findLiveHostUserId,
  hasPersistedStageLayout,
  parseLiveStageSlots,
  roleBadge,
  roleFromDb,
  stageFeedsFromUserIds,
  stageFeedsToUserIds,
  stageLayoutFingerprint,
  type LiveRoomRole,
} from '../lib/liveRoomRoles'
import { inviteLinkIsLocalOnly, liveRoomInviteUrl } from '../lib/publicAppUrl'
import LiveChatPanel, { type LiveChatExtraMessage } from './LiveChatPanel'
import CamVolumeMeter from '../components/CamVolumeMeter'
import ProfileAvatar from '../components/ProfileAvatar'
import { resumeSharedAudioContext } from '../lib/useAudioLevel'
import { isNativeShell, shouldUseMobileRoomFooter, getLiveRoomCompactMaxWidthPx } from '../lib/nativeShell'
import { enableLiveRoomSpeaker, restoreRoomAudio, setNativeLiveKeepAlive } from '../lib/orionAudio'
import { isBraveBrowser, openFilePicker, preferCssBattleFx } from '../lib/browserSupport'
import {
  cancelAllRoomWork,
  isNativePowerSave,
  mediaReplayIntervalMs,
  memberRefreshIntervalMs,
  meshWatchIntervalMs,
  peerAudioKickMs,
  peerVideoKickMs,
  peerVideoKickMaxMs,
  renogCooldownMs,
  scheduleRoomWork,
  signalPollFastDurationMs,
  signalPollFastMs,
  signalPollSteadyMs,
  virtualBgDrawMs,
} from '../lib/roomPower'
import { publishLiveClipAsReel } from '../lib/publishLiveReel'
import { acquireLiveWakeLock, shouldLeaveLiveOnPageHide } from '../lib/liveKeepAlive'
import { leaveOtherLiveRooms, leaveLiveRoomMembership } from '../lib/friendsLive'

/**
 * Multiparty mesh WebRTC (≤7 people in room including you). Signaling in Postgres — no media storage.
 * TikTok-style toggles: mute, camera off, ghost (video off to others), pin/spotlight, flip camera.
 */

type SigPayload = {
  kind: string
  to?: string
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit | null
  /** Per-device WebRTC instance — avoids EXE+APK same-account mesh conflicts. */
  sid?: string
  /** ICE restart / forced renegotiation — bypass offer dedup. */
  renog?: boolean
}

const STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
]

/** Public TURN relay — required for EXE (PC) ↔ APK (phone) on different networks when no custom TURN is set. */
const OPEN_RELAY_TURN: RTCIceServer = {
  urls: [
    'turn:openrelay.metered.ca:80',
    'turn:openrelay.metered.ca:443',
    'turn:openrelay.metered.ca:443?transport=tcp',
  ],
  username: 'openrelayproject',
  credential: 'openrelayproject',
}

function iceCandidateIsUseless(candidate: RTCIceCandidateInit) {
  const line = candidate.candidate ?? ''
  if (!line) return false
  /* Keep 127.0.0.1 — required for EXE↔EXE on the same PC (two browser ports). */
  return /\s(0\.0\.0\.0)(\s|$)/.test(line)
}
const VIRTUAL_BG_STORAGE_KEY = 'orion-room-virtual-bg'
const VIRTUAL_BG_MAX_BYTES = 1_500_000
/** Slot 0–6 ↔ Battle Royale targets (2 hero + 5 mini = 7). */
const BATTLE_TEAM_BY_SLOT = ['alpha', 'omega', 'sigma', 'zeta', 'kappa', 'delta', 'gamma'] as const
const ROYALE_TEAM_SLOT: Record<(typeof BATTLE_TEAM_BY_SLOT)[number], number> = {
  alpha: 0,
  omega: 1,
  sigma: 2,
  zeta: 3,
  kappa: 4,
  delta: 5,
  gamma: 6,
}
const LIVE_ROOM_MAX_CAMS = 7
type StageFeed = '__local' | string | null
type RoyaleSlotTeam = (typeof BATTLE_TEAM_BY_SLOT)[number]

function isCapacitorApp() {
  /* True APK/iOS only — never treat desktop EXE/browser as Capacitor. */
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

function localStreamAlive(stream: MediaStream | null) {
  if (!stream) return false
  /* At least one live track — don't treat mic-only or cam-only as "dead". */
  return stream.getTracks().some((t) => t.readyState === 'live')
}

function replayRoomVideos(root?: ParentNode | null) {
  const scope = root ?? document
  scope.querySelectorAll('video').forEach((node) => {
    const v = node as HTMLVideoElement
    if (v.srcObject) void v.play().catch(() => {})
  })
}

function replayRoomAudio(root?: ParentNode | null) {
  const scope = root ?? document
  scope.querySelectorAll('audio.room-peer-audio').forEach((node) => {
    const a = node as HTMLAudioElement
    if (a.srcObject) void a.play().catch(() => {})
  })
}

function rtcIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [...STUN]
  const turnUrl = import.meta.env.VITE_TURN_URL?.trim()
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME?.trim() || undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL?.trim() || undefined,
    })
  } else {
    servers.push(OPEN_RELAY_TURN)
  }
  return servers
}

function closePeerConnections(pcs: Map<string, RTCPeerConnection>) {
  pcs.forEach((pc) => {
    try {
      /* Close only — do not stop sender OR receiver tracks.
         Senders share localStream hardware; stopping receivers races remotes/UI. */
      pc.close()
    } catch {
      /* ignore */
    }
  })
  pcs.clear()
}

function discardMediaStream(stream: MediaStream | null | undefined) {
  if (!stream) return
  try {
    stream.getTracks().forEach((t) => {
      try {
        t.stop()
      } catch {
        /* ignore */
      }
    })
  } catch {
    /* ignore */
  }
}

/** Detach A/V elements under `root` (clears frozen last frames). Does not stop tracks. */
function detachRoomMediaElements(root?: ParentNode | null) {
  const scope = root ?? document
  scope.querySelectorAll('video, audio').forEach((node) => {
    const el = node as HTMLVideoElement | HTMLAudioElement
    try {
      el.srcObject = null
      if ('load' in el && typeof el.load === 'function') el.load()
    } catch {
      /* ignore */
    }
  })
}

/** Stage capacity 2–7: first 2 are large heroes; slots 3–N are mini filmstrip cams. */
export const CAM_LAYOUT_OPTIONS = [2, 3, 4, 5, 6, 7] as const
export type CamLayoutCount = (typeof CAM_LAYOUT_OPTIONS)[number]

function clampCamLayout(n: number): CamLayoutCount {
  const v = Math.round(Number(n) || 2)
  if (v <= 2) return 2
  if (v >= 7) return 7
  return v as CamLayoutCount
}

/** Pack occupied feeds into `count` slots (keep order; fill holes from overflow). */
function packStageSlots(slots: StageFeed[], count: number): StageFeed[] {
  const n = clampCamLayout(count)
  const next: StageFeed[] = Array.from({ length: n }, () => null)
  const overflow: StageFeed[] = []
  for (let i = 0; i < slots.length; i += 1) {
    const feed = slots[i]
    if (feed === null) continue
    if (i < n && next[i] === null) next[i] = feed
    else overflow.push(feed)
  }
  for (const feed of overflow) {
    const empty = next.findIndex((s) => s === null)
    if (empty < 0) break
    next[empty] = feed
  }
  return next
}

function nextCamLayout(current: number): CamLayoutCount {
  return clampCamLayout(clampCamLayout(current) + 1)
}

/** Binds a MediaStream to a stage video element and re-attaches after layout remounts. */
function LocalStageVideo({
  stream,
  className,
  videoRef,
  mirror = false,
}: {
  stream: MediaStream | null
  className?: string
  videoRef: React.RefObject<HTMLVideoElement | null>
  mirror?: boolean
}) {
  const bind = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el
      const live = stream ?? null
      if (el && live) {
        if (el.srcObject !== live) el.srcObject = live
        void el.play().catch(() => {})
      }
    },
    [stream, videoRef],
  )

  useEffect(() => {
    const el = videoRef.current
    const live = stream ?? null
    if (el && live) {
      if (el.srcObject !== live) el.srcObject = live
      void el.play().catch(() => {})
    }
  }, [stream, videoRef])

  const mirrorSafe = mirror && isBraveBrowser()
  const videoEl = (
    <video
      ref={bind}
      autoPlay
      playsInline
      muted
      className={className}
      style={!mirrorSafe && mirror ? { transform: 'scaleX(-1)' } : undefined}
      {...({ webkitPlaysinline: 'true', x5Playsinline: 'true' } as React.VideoHTMLAttributes<HTMLVideoElement>)}
    />
  )

  if (mirrorSafe) {
    return <div className="stage-video-mirror-wrap">{videoEl}</div>
  }

  return videoEl
}

function buildAutoStageSlots(count: number, remoteOrder: string[], prev?: StageFeed[]): StageFeed[] {
  const used = new Set<string>()
  const result: StageFeed[] = []
  for (let i = 0; i < count; i += 1) {
    const keep = prev?.[i]
    if (keep === '__local') {
      result.push('__local')
      continue
    }
    if (keep && remoteOrder.includes(keep) && !used.has(keep)) {
      result.push(keep)
      used.add(keep)
      continue
    }
    if (i === 0 && !result.includes('__local')) {
      result.push('__local')
      continue
    }
    const pick = remoteOrder.find((id) => !used.has(id) && !result.includes(id))
    if (pick) {
      result.push(pick)
      used.add(pick)
    } else {
      result.push(null)
    }
  }
  return result
}

function readStoredVirtualBg(): string | null {
  try {
    const value = localStorage.getItem(VIRTUAL_BG_STORAGE_KEY)
    return value && value.startsWith('data:image/') ? value : null
  } catch {
    return null
  }
}

type BgVideoFeed = { stream: MediaStream; stop: () => void }

function createBackgroundVideoStream(imageUrl: string, caption: string): BgVideoFeed {
  const canvas = document.createElement('canvas')
  /* Lower encode cost on APK — still looks fine on phone screens. */
  const native = (() => {
    try {
      return Capacitor.isNativePlatform()
    } catch {
      return false
    }
  })()
  canvas.width = native ? 640 : 1280
  canvas.height = native ? 360 : 720
  const ctx = canvas.getContext('2d', { alpha: false })!
  const img = new Image()

  const draw = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    ctx.fillStyle = '#070b14'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (img.complete && img.naturalWidth > 0) {
      const scale = Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight)
      const w = img.naturalWidth * scale
      const h = img.naturalHeight * scale
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)'
    ctx.fillRect(0, canvas.height - 56, canvas.width, 56)
    ctx.fillStyle = '#e8fff4'
    ctx.font = '600 28px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText(caption, 28, canvas.height - 20)
  }

  img.onload = () => draw()
  img.src = imageUrl
  draw()

  const interval = window.setInterval(draw, virtualBgDrawMs())
  const [track] = canvas.captureStream(native ? 1 : 3).getVideoTracks()
  const stream = track ? new MediaStream([track]) : new MediaStream()
  return {
    stream,
    stop: () => {
      window.clearInterval(interval)
      stream.getTracks().forEach((t) => t.stop())
    },
  }
}

type RoomActionIcon = 'home' | 'chat' | 'people' | 'mic' | 'micOff' | 'camera' | 'cameraOff' | 'swap' | 'battle' | 'bg' | 'layout' | 'ghost' | 'invite' | 'settings'

const ORION_LOGO_SRC = `${import.meta.env.BASE_URL}app-icon.svg`

/** True when the stream has a video track (mount the <video> — don't wait for readyState). */
function streamHasVideoTrack(stream: MediaStream | null | undefined): boolean {
  if (!stream) return false
  return stream.getVideoTracks().length > 0
}

/** True when the stream has a live, enabled video track worth painting. */
function streamHasRenderableVideo(stream: MediaStream | null | undefined): boolean {
  if (!stream) return false
  return stream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled)
}

/** Mount stage video whenever a track exists — decoding needs the element in DOM. */
function shouldMountStageVideo(
  isLocal: boolean,
  stream: MediaStream | null,
  localStream: MediaStream | null,
  camOn: boolean,
  ghostMode: boolean,
): boolean {
  if (isLocal) {
    if (!camOn || ghostMode) return false
    return streamHasVideoTrack(localStream)
  }
  return streamHasVideoTrack(stream)
}

/** Empty stage / filmstrip placeholder — Orion logo until a live cam fills the slot. */
function OrionSlotLogo({ label = 'Open', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div className={`stage-orion-slot${compact ? ' stage-orion-slot--compact' : ''}`} aria-hidden>
      <img src={ORION_LOGO_SRC} alt="" className="stage-orion-logo" draggable={false} />
      {!compact && <span className="stage-orion-label font-mono">{label}</span>}
    </div>
  )
}

/** Occupied slot with cam off / connecting — show profile photo (or initial). */
function SlotProfileFallback({
  src,
  name,
  compact = false,
}: {
  src?: string | null
  name?: string | null
  compact?: boolean
}) {
  return (
    <div className={`stage-profile-slot${compact ? ' stage-profile-slot--compact' : ''}`} aria-hidden>
      <ProfileAvatar src={src} name={name} size={compact ? 'md' : 'md'} className="stage-profile-slot-avatar" />
      {!compact && <span className="stage-orion-label font-mono">{name || 'Member'}</span>}
    </div>
  )
}

function RoomIcon({ name }: { name: RoomActionIcon }) {
  const svgProps = {
    viewBox: '0 0 24 24',
    width: 22,
    height: 22,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }
  if (name === 'home') {
    return (
      <svg {...svgProps}>
        <path d="M4 11.4 12 5l8 6.4V20h-5v-5.2H9V20H4z" />
      </svg>
    )
  }
  if (name === 'mic' || name === 'micOff') {
    return (
      <svg {...svgProps}>
        <path d="M12 14.5a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5.5a3 3 0 0 0 3 3Z" />
        <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3M9 20h6" />
        {name === 'micOff' && <path d="M5 5l14 14" />}
      </svg>
    )
  }
  if (name === 'camera' || name === 'cameraOff') {
    return (
      <svg {...svgProps}>
        <path d="M4 7.5h10.5A2.5 2.5 0 0 1 17 10v4a2.5 2.5 0 0 1-2.5 2.5H4z" />
        <path d="m17 11 4-2.8v7.6L17 13z" />
        {name === 'cameraOff' && <path d="M5 5l14 14" />}
      </svg>
    )
  }
  if (name === 'swap') {
    return (
      <svg {...svgProps}>
        <path d="M7 7h9.5l-2-2M16.5 7l-2 2M17 17H7.5l2 2M7.5 17l2-2" />
      </svg>
    )
  }
  if (name === 'chat') {
    return (
      <svg {...svgProps}>
        <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3V7a2 2 0 0 1 2-2Z" />
      </svg>
    )
  }
  if (name === 'people') {
    return (
      <svg {...svgProps}>
        <path d="M16 11c1.66 0 3-1.34 3-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3Z" />
        <path d="M8 13c1.66 0 3-1.34 3-3S9.66 7 8 7 5 8.34 5 10s1.34 3 3 3Z" />
        <path d="M8 15c-2.67 0-8 1.34-8 4v2h10" />
        <path d="M16 13c-1.5 0-5 .67-5 2.5V19h9" />
      </svg>
    )
  }
  if (name === 'battle') {
    return (
      <svg {...svgProps}>
        <path d="M12 3 5 6.5v5.7c0 4.1 2.8 6.8 7 8.8 4.2-2 7-4.7 7-8.8V6.5z" />
        <path d="M8.5 13.5 15.5 8M10 8l6 6" />
      </svg>
    )
  }
  if (name === 'bg') {
    return (
      <svg {...svgProps}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="8.5" cy="10" r="1.8" />
        <path d="m3 16 5.5-4.5 4 3 3.5-3L21 16" />
      </svg>
    )
  }
  if (name === 'layout') {
    return (
      <svg {...svgProps}>
        <rect x="3" y="4" width="8" height="16" rx="1.5" />
        <rect x="13" y="4" width="8" height="16" rx="1.5" />
      </svg>
    )
  }
  if (name === 'ghost') {
    return (
      <svg {...svgProps}>
        <path d="M12 2a7 7 0 0 0-7 7v3H4v9h16v-9h-1V9a7 7 0 0 0-7-7Z" />
        <circle cx="9" cy="11" r="1.2" />
        <circle cx="15" cy="11" r="1.2" />
      </svg>
    )
  }
  if (name === 'invite') {
    return (
      <svg {...svgProps}>
        <path d="M16 11c1.66 0 3-1.34 3-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3Z" />
        <path d="M8 13c1.66 0 3-1.34 3-3S9.66 7 8 7 5 8.34 5 10s1.34 3 3 3Z" />
        <path d="M8 15c-2.67 0-8 1.34-8 4v2h10" />
        <path d="M16 13c-1.5 0-5 .67-5 2.5V19h9" />
        <path d="M19 16v6M16 19h6" />
      </svg>
    )
  }
  if (name === 'settings') {
    return (
      <svg {...svgProps}>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6" />
      </svg>
    )
  }
  return (
    <svg {...svgProps}>
      <path d="M12 4.5 14 9l4.8.5-3.6 3.2 1 4.8L12 15l-4.2 2.5 1-4.8-3.6-3.2L10 9z" />
    </svg>
  )
}

function battleFxKind(hit: BattleCameraHit) {
  const name = hit.giftName.toLowerCase()
  if (name.includes('dragon')) return 'dragon'
  if (/meteor|comet|starfall|moonshot|rocket/.test(name)) return 'meteor'
  if (/ice|frost|blizzard|avalanche|crystal|diamond/.test(name)) return 'ice'
  if (/thunder|lightning|sonic/.test(name)) return 'thunder'
  if (/solar|sun|flare|phoenix|firework/.test(name)) return 'solar'
  if (/vortex|cyclone|tornado|gravity|orbit|carousel/.test(name)) return 'vortex'
  if (/laser|plasma|quantum|ion|pulse|cannon|beam/.test(name)) return 'beam'
  if (/shield|arc|blade|harpoon|spear|lance|strike/.test(name)) return 'slash'
  if (/glitch|matrix|rift|nebula|shadow|echo/.test(name)) return 'glitch'
  if (/snowball|tidal|wave|rain|aurora/.test(name)) return 'wave'
  return hit.effectClass === 'static-boost' ? 'boost' : 'burst'
}

function fxHue(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 360
  return hash
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

function createPlaceholderVideoStream(): MediaStream {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#070b14'
    ctx.fillRect(0, 0, 640, 360)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.42)'
    ctx.strokeRect(10, 10, 620, 340)
    ctx.font = '15px ui-monospace, monospace'
    ctx.fillStyle = 'rgba(226, 232, 240, 0.9)'
    ctx.fillText('No camera permission — reconnect when allowed.', 26, 170)
    ctx.font = '12px ui-monospace, monospace'
    ctx.fillStyle = 'rgba(148, 163, 184, 0.82)'
    ctx.fillText('Address bar 🔒 → Site settings → Camera / Mic', 26, 200)
  }
  /* Static placeholder — 1 fps is enough (was 10fps encode heat). */
  const vst = canvas.captureStream(1).getVideoTracks()
  return vst[0] ? new MediaStream([vst[0]]) : new MediaStream()
}

async function acquireLocalMedia(
  backCam: boolean,
  audioDeviceId?: string,
): Promise<{ stream: MediaStream; hint: string | null; hasCamera: boolean }> {
  const vOpt: MediaTrackConstraints = { facingMode: backCam ? 'environment' : 'user' }
  const audio: boolean | MediaTrackConstraints = audioDeviceId
    ? { deviceId: { ideal: audioDeviceId } }
    : true

  const tryOnce = async (): Promise<{ stream: MediaStream; hint: string | null; hasCamera: boolean } | null> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: vOpt })
      return { stream, hint: null, hasCamera: stream.getVideoTracks().length > 0 }
    } catch {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
        return {
          stream,
          hint:
            'Camera blocked or unavailable — set a background image or allow camera in site settings.',
          hasCamera: false,
        }
      } catch {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: vOpt })
          return { stream, hint: 'Microphone blocked — sending video-only until you enable the mic.', hasCamera: true }
        } catch {
          return null
        }
      }
    }
  }

  /* Android often needs a short settle after previous session stopped the camera. */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(280 * attempt)
    const got = await tryOnce()
    /* Mic-only is a first-class live mode (mini cams + stage) — accept after one camera retry. */
    if (got && (got.hasCamera || attempt >= 1)) return got
    if (got && !got.hasCamera) {
      got.stream.getTracks().forEach((t) => t.stop())
    }
  }

  return {
    stream: createPlaceholderVideoStream(),
    hint:
      'Camera and microphone blocked — add a background image below or allow access in site settings.',
    hasCamera: false,
  }
}

/** Acquire one video track for front/back — new track before stopping old (required on Android). */
async function acquireVideoTrackForFacing(backCam: boolean): Promise<MediaStreamTrack | null> {
  const want = backCam ? 'environment' : 'user'
  const attempts: MediaTrackConstraints[] = [
    { facingMode: want, width: { ideal: 1280 }, height: { ideal: 720 } },
    { facingMode: want },
    { facingMode: { exact: want } },
  ]

  for (const video of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video })
      const [track] = stream.getVideoTracks()
      if (track) {
        stream.getAudioTracks().forEach((t) => t.stop())
        return track
      }
      stream.getTracks().forEach((t) => t.stop())
    } catch {
      /* try next constraint set */
    }
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cams = devices.filter((d) => d.kind === 'videoinput')
    if (cams.length >= 2) {
      const pick = backCam
        ? cams.find((d) => /back|rear|environment/i.test(d.label)) ?? cams[cams.length - 1]
        : cams.find((d) => /front|user|face|selfie/i.test(d.label)) ?? cams[0]
      if (pick?.deviceId) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: { exact: pick.deviceId } },
        })
        const [track] = stream.getVideoTracks()
        if (track) return track
        stream.getTracks().forEach((t) => t.stop())
      }
    }
  } catch {
    /* enumerate fallback failed */
  }

  if (isCapacitorApp()) {
    await new Promise((r) => window.setTimeout(r, 320))
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: want },
      })
      const [track] = stream.getVideoTracks()
      if (track) return track
      stream.getTracks().forEach((t) => t.stop())
    } catch {
      /* final retry failed */
    }
  }

  return null
}

export default function VideoRoom({ me }: { me: Profile }) {
  const { conversationId } = useParams<{ conversationId: string }>()
  const nav = useNavigate()
  const [qs] = useSearchParams()
  const peerHint = qs.get('peer') ?? ''

  const localRef = useRef<HTMLVideoElement>(null)
  const localMiniRef = useRef<HTMLVideoElement>(null)
  const localSelfPipRef = useRef<HTMLVideoElement>(null)
  const bgFileInputRef = useRef<HTMLInputElement>(null)
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamCacheRef = useRef<Map<string, MediaStream>>(new Map())
  const bgFeedRef = useRef<BgVideoFeed | null>(null)
  const hasRealCameraRef = useRef(false)
  const virtualBgRef = useRef<string | null>(readStoredVirtualBg())
  const selectedMicIdRef = useRef('')
  const layoutSyncRef = useRef<ReturnType<typeof attachRoomLayoutSync> | null>(null)
  const suppressLayoutSyncRef = useRef(false)
  const stageFingerprintRef = useRef('')
  const stageHydratedRef = useRef(false)
  const healMeshRef = useRef<(() => void) | null>(null)
  const syncMeshPeersRef = useRef<(() => void) | null>(null)
  /** Coalesced mesh nudge — prefer this over calling sync+heal back-to-back. */
  const nudgeMesh = useCallback((delayMs = 160) => {
    scheduleRoomWork('mesh-nudge', () => {
      healMeshRef.current?.()
    }, delayMs)
  }, [])
  const nudgeMeshRef = useRef(nudgeMesh)
  nudgeMeshRef.current = nudgeMesh
  const roomMemberIdsRef = useRef<string[]>([])
  const hostStageEnsuredRef = useRef(false)
  const pendingLayoutSyncRef = useRef<RoomLayoutSync | null>(null)
  const applySyncedStageRef = useRef<(camCount: number, userSlots?: (string | null)[]) => void>(() => {})
  const leavingRef = useRef(false)
  const leaveAttemptAtRef = useRef(0)
  /** Set as soon as conv bootstrap reads kind — do not wait on React titles state for leave. */
  const roomKindRef = useRef<string | undefined>(undefined)
  const liveMemberRef = useRef(false)
  const membershipLeftRef = useRef(false)
  const switchingRoomRef = useRef(false)
  const mediaReleasedRef = useRef(false)
  const remoteOrderRef = useRef<string[]>([])
  const resumeRtcRef = useRef<((opts?: { soft?: boolean; remount?: boolean }) => Promise<void>) | null>(
    null,
  )
  const lastHomeResumeAtRef = useRef(0)
  const roomRootRef = useRef<HTMLDivElement>(null)
  const myRtcSidRef = useRef(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `rtc-${Date.now()}`,
  )
  const remoteRtcSidRef = useRef<Map<string, string>>(new Map())

  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [peerNames, setPeerNames] = useState<Record<string, string>>({})
  const [peerAvatars, setPeerAvatars] = useState<Record<string, string>>({})
  const [roomMemberIds, setRoomMemberIds] = useState<string[]>([])
  const [battleChatExtras, setBattleChatExtras] = useState<LiveChatExtraMessage[]>([])
  const [virtualBgUrl, setVirtualBgUrl] = useState<string | null>(() => readStoredVirtualBg())
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedMicId, setSelectedMicId] = useState('')
  const [battleHits, setBattleHits] = useState<BattleCameraHit[]>([])
  const battleHitSeqRef = useRef(0)
  const chatEventSeqRef = useRef(0)
  const stageRefsMap = useRef<Map<number, HTMLDivElement>>(new Map())
  const [titles, setTitles] = useState<{ room?: string; kind?: string }>({})
  const [status, setStatus] = useState('Joining…')
  const [err, setErr] = useState<string | null>(null)
  /** Non-blocking: mic/cam denial — still render live grid + chat. */
  const [mediaWarn, setMediaWarn] = useState<string | null>(null)
  const [mediaWarnDismissed, setMediaWarnDismissed] = useState(false)
  const [braveHintDismissed, setBraveHintDismissed] = useState(false)

  const [camOn, setCamOn] = useState(true)
  const [micOn, setMicOn] = useState(true)
  const [ghostMode, setGhostMode] = useState(false)
  const [pinnedPeer, setPinnedPeer] = useState<string | null>(null)
  const backCamRef = useRef(false)
  const lastVideoDeviceIdRef = useRef<string | null>(null)
  const resumeInFlightRef = useRef(false)
  const battleStopResetRef = useRef<(() => void) | null>(null)
  /** Bumped on resume so remote <video> tiles remount (fixes Cam 2 black/play-icon after Home). */
  const [videoEpoch, setVideoEpoch] = useState(0)
  const [facingBack, setFacingBack] = useState(false)

  /** Bumps to re-run signalling / local media acquisition after permission fixes. */
  const [rtcBootKey, setRtcBootKey] = useState(0)

  // ── Battle Royale (all 7 stage cams) ───────────────────────────────────────
  const [royaleActive, setRoyaleActive] = useState(false)
  const [royaleEliminated, setRoyaleEliminated] = useState<string[]>([])
  const [royaleWinnerTeam, setRoyaleWinnerTeam] = useState<string | null>(null)
  // Battle panel state lifted for camera overlays
  const [battleState, setBattleState] = useState({
    scores: { alpha: 0, omega: 0 } as Record<string, number>,
    royaleScores: {
      alpha: 0,
      omega: 0,
      sigma: 0,
      zeta: 0,
      kappa: 0,
      delta: 0,
      gamma: 0,
    } as Record<string, number>,
    enabled: false, royaleMode: false, wallet: 200,
    target: 'omega', royaleTarget: 'omega', selectedGiftId: '',
  })
  const [battlePanelOpen, setBattlePanelOpen] = useState(false)
  const [studioRailTab, setStudioRailTab] = useState<'chat' | 'battle' | 'people'>('chat')
  const [leagueTop, setLeagueTop] = useState<BattleLeagueRow[]>([])
  const [otherLives, setOtherLives] = useState<Array<{ id: string; title: string; members: number }>>([])
  const [joiningLiveId, setJoiningLiveId] = useState<string | null>(null)
  const [stageLayoutCount, setStageLayoutCount] = useState(7)
  const [stageSlots, setStageSlots] = useState<StageFeed[]>(() => Array.from({ length: 7 }, () => null))
  const [slotMenuIndex, setSlotMenuIndex] = useState<number | null>(null)
  const [slotMenuPos, setSlotMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [plusMenuPos, setPlusMenuPos] = useState<{ top: number; right: number } | null>(null)
  const [myRoomRole, setMyRoomRole] = useState<LiveRoomRole>('member')
  const [memberRoles, setMemberRoles] = useState<Record<string, LiveRoomRole>>({})
  const [modsEnabled, setModsEnabled] = useState(true)
  const [roomCreatorId, setRoomCreatorId] = useState<string | null>(null)
  const [presenceOpen, setPresenceOpen] = useState(false)
  const [mobileSheet, setMobileSheet] = useState<'none' | 'chat' | 'battle' | 'settings'>('none')
  const [stageRequestIds, setStageRequestIds] = useState<string[]>([])
  /** Host/mod forced mutes — target cannot unmute until cleared. */
  const [hostMutedIds, setHostMutedIds] = useState<string[]>([])
  const hostMutedIdsRef = useRef<Set<string>>(new Set())
  hostMutedIdsRef.current = new Set(hostMutedIds)
  const [portalMobileFooter, setPortalMobileFooter] = useState(() =>
    typeof window !== 'undefined' &&
    shouldUseMobileRoomFooter(
      window.matchMedia(`(max-width: ${getLiveRoomCompactMaxWidthPx()}px)`).matches,
    ),
  )
  const rtcRestartRef = useRef(false)
  const [hostPanelOpen, setHostPanelOpen] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)
  const stageLayoutCountRef = useRef(stageLayoutCount)
  stageLayoutCountRef.current = stageLayoutCount
  const stageSlotsRef = useRef(stageSlots)
  stageSlotsRef.current = stageSlots
  const preRoyaleLayoutRef = useRef(2)
  const memberRolesRef = useRef<Record<string, LiveRoomRole>>({})
  const modsEnabledRef = useRef(true)
  const canManageStageRef = useRef(false)
  const roomCreatorIdRef = useRef<string | null>(null)
  const membersReadyRef = useRef(false)
  const persistAndBroadcastStageRef = useRef<
    (count: number, slots: StageFeed[]) => Promise<void>
  >(async () => {})
  const loadRoomRolesRef = useRef<(opts?: { hydrateStage?: boolean }) => Promise<void>>(async () => {})
  const addFeedToStageRef = useRef<(feed: string | '__local', opts?: { fromPeopleList?: boolean }) => void>(() => {})
  memberRolesRef.current = memberRoles
  modsEnabledRef.current = modsEnabled
  roomCreatorIdRef.current = roomCreatorId

  // ── Like Power ───────────────────────────────────────────────────────────
  const [likes, setLikes] = useState(0)
  const likeLeaguePoints = Math.floor(likes / 100_000)
  const pendingLikeDeltaRef = useRef(0)
  const likeFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPendingLikes = useCallback(async () => {
    if (!supabase || !conversationId || titles.kind !== 'live') {
      pendingLikeDeltaRef.current = 0
      return
    }
    const delta = pendingLikeDeltaRef.current
    if (delta <= 0) return
    pendingLikeDeltaRef.current = 0
    // Chunk large bursts to stay under RPC max (500).
    let left = delta
    while (left > 0) {
      const chunk = Math.min(left, 500)
      left -= chunk
      const { error } = await supabase.rpc('record_live_likes', {
        p_conversation_id: conversationId,
        p_delta: chunk,
      })
      if (error) {
        // Keep UI likes; re-queue failed chunk for a later flush attempt.
        pendingLikeDeltaRef.current += chunk + left
        console.warn('[orion] record_live_likes', error.message)
        break
      }
    }
  }, [conversationId, titles.kind])

  const queueLiveLikeLog = useCallback(
    (delta = 1) => {
      if (!conversationId || titles.kind !== 'live' || delta <= 0) return
      pendingLikeDeltaRef.current += delta
      if (likeFlushTimerRef.current) clearTimeout(likeFlushTimerRef.current)
      likeFlushTimerRef.current = setTimeout(() => {
        likeFlushTimerRef.current = null
        void flushPendingLikes()
      }, 450)
    },
    [conversationId, titles.kind, flushPendingLikes],
  )

  useEffect(() => {
    return () => {
      if (likeFlushTimerRef.current) {
        clearTimeout(likeFlushTimerRef.current)
        likeFlushTimerRef.current = null
      }
      void flushPendingLikes()
    }
  }, [flushPendingLikes])

  /** Hydrate room like total from DB so EXE/APK stay aligned (broadcast alone drifts). */
  useEffect(() => {
    if (!supabase || !conversationId || titles.kind !== 'live') {
      setLikes(0)
      return
    }
    let cancelled = false
    const client = supabase
    const hydrate = async () => {
      const { data, error } = await client
        .from('live_like_events')
        .select('delta')
        .eq('conversation_id', conversationId)
      if (cancelled || error) return
      const total = ((data ?? []) as Array<{ delta: number }>).reduce(
        (sum, row) => sum + (Number(row.delta) || 0),
        0,
      )
      setLikes((prev) => Math.max(prev, total + pendingLikeDeltaRef.current))
    }
    void hydrate()
    /* Offset from mesh/member timers so polls don't stampede together. */
    const tick = window.setInterval(() => void hydrate(), 18_000)
    return () => {
      cancelled = true
      window.clearInterval(tick)
    }
  }, [conversationId, titles.kind])

  /* Keep Friends Live accurate: heartbeat while in room.
   * APK Home / app-switch must NOT leave — session stays 100% alive until Lobby. */
  useEffect(() => {
    if (!conversationId || !supabase || titles.kind !== 'live') return
    const client = supabase
    const cid = conversationId
    const beat = () => {
      void client.rpc('touch_live_presence', { p_conversation_id: cid }).then(
        () => undefined,
        () => undefined,
      )
    }
    beat()
    const tick = window.setInterval(beat, 25_000)
    const leaveBestEffort = () => {
      if (!shouldLeaveLiveOnPageHide()) return
      if (leavingRef.current || membershipLeftRef.current) return
      try {
        void leaveLiveRoomMembership(cid, me.id).then((ok) => {
          if (ok) {
            liveMemberRef.current = false
            membershipLeftRef.current = true
          }
        })
      } catch {
        /* ignore */
      }
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') beat()
    }
    /* Desktop tab close only — never on Capacitor Home. */
    if (shouldLeaveLiveOnPageHide()) {
      window.addEventListener('pagehide', leaveBestEffort)
      window.addEventListener('beforeunload', leaveBestEffort)
    }
    document.addEventListener('visibilitychange', onVis)
    const releaseWake = acquireLiveWakeLock()
    void setNativeLiveKeepAlive(true)
    return () => {
      window.clearInterval(tick)
      window.removeEventListener('pagehide', leaveBestEffort)
      window.removeEventListener('beforeunload', leaveBestEffort)
      document.removeEventListener('visibilitychange', onVis)
      releaseWake()
      void setNativeLiveKeepAlive(false)
    }
  }, [conversationId, titles.kind])

  // ── Record Live / Clip → Reel ────────────────────────────────────────────
  const clipRecorderRef = useRef<MediaRecorder | null>(null)
  const clipChunksRef = useRef<Blob[]>([])
  const clipBlobRef = useRef<Blob | null>(null)
  const clipMaxRef = useRef(30)
  const [clipping, setClipping] = useState(false)
  const [clipReady, setClipReady] = useState(false)
  const [clipSeconds, setClipSeconds] = useState(0)
  const [clipMaxSeconds, setClipMaxSeconds] = useState(30)
  const [publishingReel, setPublishingReel] = useState(false)
  const [reelPosted, setReelPosted] = useState(false)
  const clipTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const camOnRef = useRef(camOn)
  const micOnRef = useRef(micOn)
  const ghostRef = useRef(ghostMode)
  camOnRef.current = camOn
  micOnRef.current = micOn
  ghostRef.current = ghostMode

  const loadPeerNames = useCallback(async (ids: string[]) => {
    if (!supabase) return
    const unique = [...new Set(ids.filter(Boolean))]
    if (!unique.length) return
    const { data, error } = await supabase.from('profiles').select('id,display_name,avatar_url').in('id', unique)
    if (error || !data?.length) return
    setPeerNames((prev) => {
      const next = { ...prev }
      for (const row of data) {
        const profile = row as Profile
        const name = profile.display_name?.trim()
        if (name) next[profile.id] = name
      }
      return next
    })
    setPeerAvatars((prev) => {
      const next = { ...prev }
      for (const row of data) {
        const profile = row as Profile
        const url = profile.avatar_url?.trim()
        if (url) next[profile.id] = url
        else if (!(profile.id in next)) next[profile.id] = ''
      }
      return next
    })
  }, [])

  function peerAvatarUrl(uid: string) {
    if (uid === me.id) return me.avatar_url ?? ''
    return peerAvatars[uid] ?? ''
  }

  const refreshMicDevices = useCallback(async (opts?: { requestPermission?: boolean }) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMicDevices([])
      return
    }
    try {
      /* Labels stay blank until mic permission — EXE/Chrome need a real getUserMedia first. */
      if (opts?.requestPermission) {
        try {
          const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          probe.getTracks().forEach((t) => t.stop())
        } catch {
          /* still enumerate — may get deviceIds without labels */
        }
      }
      const devices = await navigator.mediaDevices.enumerateDevices()
      const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId)
      setMicDevices(mics)
      if (!selectedMicIdRef.current && mics.length === 1 && mics[0]!.deviceId) {
        selectedMicIdRef.current = mics[0]!.deviceId
        setSelectedMicId(mics[0]!.deviceId)
      }
    } catch {
      setMicDevices([])
    }
  }, [])

  function stopBgFeed() {
    bgFeedRef.current?.stop()
    bgFeedRef.current = null
  }

  function applyMicEnabled(enabled: boolean) {
    micOnRef.current = enabled
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = enabled
    })
    pcsRef.current.forEach((pc) => {
      pc.getSenders().forEach((snd) => {
        if (snd.track?.kind === 'audio') snd.track.enabled = enabled
      })
    })
  }

  function toggleMic() {
    if (hostMutedIdsRef.current.has(me.id)) return
    setMicOn((prev) => {
      const next = !prev
      applyMicEnabled(next)
      return next
    })
  }

  function replaceOutgoingAudioTrack(nextTrack: MediaStreamTrack | null) {
    const s = localStreamRef.current
    if (!s || !nextTrack) return
    const [old] = s.getAudioTracks()
    if (old) {
      s.removeTrack(old)
      old.stop()
    }
    nextTrack.enabled = !!micOnRef.current
    s.addTrack(nextTrack)
    pcsRef.current.forEach((pc) => {
      const snd = pc.getSenders().find((x) => x.track?.kind === 'audio')
      if (snd) void snd.replaceTrack(nextTrack)
      else pc.addTrack(nextTrack, s)
    })
  }

  function replaceOutgoingVideoTrack(nextTrack: MediaStreamTrack | null) {
    const s = localStreamRef.current
    if (!s) return
    const [old] = s.getVideoTracks()
    if (old) {
      s.removeTrack(old)
      if (old !== nextTrack) old.stop()
    }
    if (nextTrack) {
      nextTrack.enabled = !!(camOnRef.current && !ghostRef.current)
      s.addTrack(nextTrack)
    }
    pcsRef.current.forEach((pc) => {
      const snd = pc.getSenders().find((x) => x.track?.kind === 'video')
      if (snd) {
        void snd.replaceTrack(nextTrack)
        return
      }
      if (nextTrack) pc.addTrack(nextTrack, s)
    })
    for (const ref of [localRef, localMiniRef, localSelfPipRef]) {
      const el = ref.current
      if (!el) continue
      el.srcObject = s
      void el.play().catch(() => {})
    }
    /* Force React to see the track swap (same MediaStream ref). */
    setLocalStream(s)
  }

  /** Re-open the device camera after a virtual BG replaced/stopped it. */
  async function restoreRealCameraTrack(): Promise<boolean> {
    const vt = await acquireVideoTrackForFacing(backCamRef.current)
    if (!vt) return false
    hasRealCameraRef.current = true
    const vid = vt.getSettings?.()?.deviceId
    if (vid) lastVideoDeviceIdRef.current = vid
    replaceOutgoingVideoTrack(vt)
    setMediaWarn(null)
    return true
  }

  const applyVirtualBackground = useCallback(
    (url: string | null) => {
      virtualBgRef.current = url
      setVirtualBgUrl(url)
      if (!url) {
        stopBgFeed()
        /* BG replace() stops the real cam track — must re-acquire to get live cam back. */
        void (async () => {
          if (hasRealCameraRef.current) {
            const ok = await restoreRealCameraTrack()
            if (ok) return
          }
          const [placeholder] = createPlaceholderVideoStream().getVideoTracks()
          replaceOutgoingVideoTrack(placeholder ?? null)
          if (hasRealCameraRef.current) {
            setMediaWarn('Could not reopen camera — tap Camera off/on or Flip to retry.')
          }
        })()
        return
      }
      stopBgFeed()
      const feed = createBackgroundVideoStream(url, me.display_name?.trim() || 'You')
      bgFeedRef.current = feed
      const [track] = feed.stream.getVideoTracks()
      if (track) replaceOutgoingVideoTrack(track)
    },
    [me.display_name],
  )

  useEffect(() => {
    const ids = [...new Set([...roomMemberIds, ...Object.keys(remoteStreams)])]
    void loadPeerNames(ids)
  }, [loadPeerNames, roomMemberIds, remoteStreams])

  useEffect(() => {
    void refreshMicDevices({ requestPermission: true })
    const onDeviceChange = () => {
      void refreshMicDevices()
    }
    navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
  }, [refreshMicDevices])

  useEffect(() => {
    const s = localStreamRef.current
    if (!s) return
    s.getVideoTracks().forEach((t) => {
      t.enabled = !!(camOnRef.current && !ghostRef.current)
    })
    s.getAudioTracks().forEach((t) => {
      t.enabled = !!micOnRef.current
    })
  }, [camOn, micOn, ghostMode])

  useEffect(() => {
    leavingRef.current = false
    leaveAttemptAtRef.current = 0
    roomKindRef.current = undefined
    liveMemberRef.current = false
    membershipLeftRef.current = false
    switchingRoomRef.current = false
    stageHydratedRef.current = false
    stageFingerprintRef.current = ''
    hostStageEnsuredRef.current = false
    membersReadyRef.current = false
  }, [conversationId])

  useEffect(() => {
    if (!conversationId || !supabase || titles.kind !== 'live') return
    const client = supabase

    const refreshOtherLives = async () => {
      const withCategory = await client
        .from('conversations')
        .select('id,title,kind,live_listed')
        .eq('kind', 'live')
        .eq('live_listed', true)
        .order('title', { ascending: true })
        .limit(40)
      if (withCategory.error) {
        setOtherLives([])
        return
      }
      const rooms = ((withCategory.data ?? []) as Array<{ id: string; title: string | null }>)
        .filter((r) => r.id !== conversationId)
        .slice(0, 6)
      if (rooms.length === 0) {
        setOtherLives([])
        return
      }
      const ids = rooms.map((r) => r.id)
      const { data: members } = await client
        .from('conversation_members')
        .select('conversation_id')
        .in('conversation_id', ids)
      const counts = new Map<string, number>()
      for (const row of members ?? []) {
        const cid = (row as { conversation_id: string }).conversation_id
        counts.set(cid, (counts.get(cid) ?? 0) + 1)
      }
      setOtherLives(
        rooms.map((r) => ({
          id: r.id,
          title: r.title?.trim() || 'Live',
          members: counts.get(r.id) ?? 0,
        })),
      )
    }

    void refreshOtherLives()
    const chan = client
      .channel(`room-other-lives:${conversationId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        () => void refreshOtherLives(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversation_members' },
        () => void refreshOtherLives(),
      )
      .subscribe()
    return () => {
      void client.removeChannel(chan)
    }
  }, [conversationId, titles.kind])

  useEffect(() => {
    if (!conversationId || !supabase || titles.kind !== 'live') return
    const client = supabase
    const refreshMembers = async () => {
      const { data } = await client
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', conversationId)
      const peers = [...new Set((data ?? []).map((r) => r.user_id))]
        .filter((id) => id !== me.id)
        .sort((a, b) => a.localeCompare(b))
      setRoomMemberIds(peers)
      roomMemberIdsRef.current = peers
      void loadPeerNames(peers)
      syncMeshPeersRef.current?.()
    }
    void refreshMembers()
    const refreshStage = async () => {
      /* Used to skip re-sync entirely for hosts/mods, on the assumption they're
       * the ones writing stage state so don't need to read it back. But that
       * meant their own client never picked up layout changes from anywhere
       * else, which is exactly what forced a manual refresh to "see everyone
       * again." Hosts poll too now — cheap read, harmless if already correct. */
      if (!client || !stageHydratedRef.current) return
      const { data } = await client
        .from('conversations')
        .select('live_cam_count, live_stage_slots')
        .eq('id', conversationId)
        .maybeSingle()
      if (!data) return
      const persisted = parseLiveStageSlots(data.live_stage_slots)
      const camCount = (data.live_cam_count as number | undefined) ?? stageLayoutCountRef.current
      if (hasPersistedStageLayout(data.live_cam_count, persisted) || persisted.some((s) => s !== null)) {
        applySyncedStageRef.current(camCount, persisted)
        return
      }
      /* DB empty but local stage also empty — keep asking host via fingerprint miss; show host if known. */
      const localEmpty = !stageSlotsRef.current.some((s) => s !== null)
      if (localEmpty) {
        const hostUid =
          roomCreatorIdRef.current && roomCreatorIdRef.current !== me.id
            ? roomCreatorIdRef.current
            : findLiveHostUserId(memberRolesRef.current, roomCreatorIdRef.current, [me.id, ...roomMemberIdsRef.current], me.id)
        if (hostUid) applySyncedStageRef.current(2, [hostUid, null])
      }
    }
    const initialStageTimer = window.setTimeout(() => void refreshStage(), 900)
    /* Stagger members vs stage so they don't double-hit Supabase on the same tick. */
    let refreshTick = 0
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      refreshTick += 1
      if (refreshTick % 2 === 1) void refreshMembers()
      else void refreshStage()
    }, memberRefreshIntervalMs())
    return () => {
      window.clearTimeout(initialStageTimer)
      window.clearInterval(timer)
    }
  }, [conversationId, titles.kind, me.id, loadPeerNames])

  useEffect(() => {
    const maxPx = getLiveRoomCompactMaxWidthPx()
    const mq = window.matchMedia(`(max-width: ${maxPx}px)`)
    const sync = () => setPortalMobileFooter(shouldUseMobileRoomFooter(mq.matches))
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (!isCapacitorApp() || !conversationId) return
    let disposed = false
    let removeListener: (() => void) | undefined
    let softResumeTimer: number | null = null

    void import('@capacitor/app')
      .then(({ App }) =>
        App.addListener('appStateChange', ({ isActive }) => {
          if (disposed) return
          if (!isActive) {
            /* Home / switcher — stay in the live. Do not leave, do not kill mesh. */
            return
          }
          /* Back into the app — soft resume only (no full-stage remount). */
          if (leavingRef.current || mediaReleasedRef.current) return
          const now = Date.now()
          if (now - lastHomeResumeAtRef.current < 1200) return
          lastHomeResumeAtRef.current = now
          void supabase?.rpc('touch_live_presence', { p_conversation_id: conversationId }).then(
            () => undefined,
            () => undefined,
          )
          if (softResumeTimer != null) window.clearTimeout(softResumeTimer)
          softResumeTimer = window.setTimeout(() => {
            softResumeTimer = null
            if (leavingRef.current || mediaReleasedRef.current || disposed) return
            void loadRoomRolesRef.current?.({ hydrateStage: false })
            void enableLiveRoomSpeaker()
            /* Soft: replay + mesh repair if remotes missing. No stage remount unless cam died. */
            void resumeRtcRef.current?.({ soft: true })
            healMeshRef.current?.()
            replayRoomVideos(roomRootRef.current)
            replayRoomAudio(roomRootRef.current)
          }, 220)
          window.setTimeout(() => {
            if (leavingRef.current || mediaReleasedRef.current || disposed) return
            replayRoomVideos(roomRootRef.current)
            replayRoomAudio(roomRootRef.current)
          }, 650)
        }),
      )
      .then((handle) => {
        if (disposed) {
          void handle.remove()
          return
        }
        removeListener = () => {
          void handle.remove()
        }
      })
      .catch(() => {})

    return () => {
      disposed = true
      if (softResumeTimer != null) window.clearTimeout(softResumeTimer)
      removeListener?.()
    }
  }, [conversationId])

  useEffect(() => {
    if (mobileSheet !== 'settings' || isCapacitorApp()) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (
        t.closest(
          '.live-toolbar-plus-wrap, .live-toolbar-plus-menu--portal, .mobile-settings-sheet, .mobile-settings-close',
        )
      ) {
        return
      }
      closeMobileSheet()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [mobileSheet])

  useEffect(() => {
    if (!conversationId || !supabase) return

    mediaReleasedRef.current = false
    resumeRtcRef.current = null

    let stopped = false
    let meshWatch: number | null = null
    let signalPollTimer: number | null = null
    let signalPollFastTimer: number | null = null
    const client = supabase
    let subscribedChan: ReturnType<(typeof client)['channel']> | null = null

    const bumpRemote = (pid: string, ms: MediaStream | null) => {
      setRemoteStreams((prev) => {
        const next = { ...prev }
        if (!ms) delete next[pid]
        else next[pid] = ms
        return next
      })
    }

    const sessionAlive = () =>
      !stopped && !leavingRef.current && !mediaReleasedRef.current

    const attachLocal = (stream: MediaStream) => {
      if (!sessionAlive()) {
        discardMediaStream(stream)
        return
      }
      localStreamRef.current = stream
      setLocalStream(stream)
      const [vt] = stream.getVideoTracks()
      const vid = vt?.getSettings?.()?.deviceId
      if (vid) lastVideoDeviceIdRef.current = vid
      if (localRef.current) {
        localRef.current.srcObject = stream
        void localRef.current.play().catch(() => {})
      }
      const mini = localMiniRef.current
      if (mini) {
        mini.srcObject = stream
        void mini.play().catch(() => {})
      }
    }

    const sendSignal = async (payload: SigPayload) => {
      if (!sessionAlive()) return
      const { error } = await client.from('webrtc_signals').insert({
        room_id: conversationId,
        sender_id: me.id,
        payload: { ...payload, sid: myRtcSidRef.current },
      })
      if (error) console.warn('[signal send]', error.message)
    }

    const run = async () => {
      setErr(null)
      setMediaWarn(null)

      const { data: conv, error: convErr } = await client
        .from('conversations')
        .select('kind,title,live_listed,creator_id')
        .eq('id', conversationId)
        .maybeSingle()
      if (convErr || !conv) {
        const base =
          conversationId?.length !== 36
            ? 'Bad room id in URL — use the full UUID from Lobby or copied invite link. '
            : ''
        const rlsHint =
          'Usually: (1) you are not in that DM/chat — reopen from Lobby on the person/listing, '
        const liveHint =
          '(2) for shared live URLs the Supabase policy must allow **listed** live rows to be read '
        const sqlHint =
          'Run **`supabase/DELTA_RUN_IN_SQL_EDITOR.sql`** (same as **`migrations/20260211193000_delta_rls_is_conv_member_realtime.sql`**) in Dashboard → SQL — fixes **infinite recursion** on `conversation_members`, listed-live reads, and Realtime publication.'
        setErr(
          base +
            (convErr?.message ?? 'Conversation not found or not visible to your session (RLS or wrong link).') +
            ' — ' +
            rlsHint +
            liveHint +
            sqlHint,
        )
        return
      }
      const kind = (conv as { kind: string }).kind
      const title = (conv as { title?: string }).title
      roomKindRef.current = kind
      setTitles({ room: title ?? '', kind })

      const { data: myRow } = await client
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', conversationId)
        .eq('user_id', me.id)
        .maybeSingle()

      let joinedLiveNow = false
      if (kind === 'live') {
        await leaveOtherLiveRooms(conversationId, me.id)
        const { error: je } = await client.rpc('join_live_room', {
          p_conversation_id: conversationId,
        })
        if (je) {
          setErr(je.message)
          return
        }
        joinedLiveNow = true
        liveMemberRef.current = true
        membershipLeftRef.current = false
        stageHydratedRef.current = false
        hostStageEnsuredRef.current = false
      }

      await loadRoomRolesRef.current({ hydrateStage: joinedLiveNow || !stageHydratedRef.current })

      if (kind === 'live' && !canManageStageRef.current) {
        window.setTimeout(() => nudgeMeshRef.current?.(40), 150)
      }

      if (!myRow?.user_id && kind !== 'live') {
        setErr('You are not in this chat — open Video from Lobby after creating a DM.')
        return
      }

      type MemberRow = { user_id: string }
      const peerIdsFromMembers = (ms: MemberRow[] | null | undefined): string[] =>
        [...new Set((ms ?? []).map((r) => r.user_id))]
          .filter((id) => id !== me.id)
          .sort((a, b) => a.localeCompare(b))

      let offerSlot = 0
      let stream: MediaStream

      let { data: members } = await client
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', conversationId)
      let peers = peerIdsFromMembers(members)
      setRoomMemberIds(peers)
      roomMemberIdsRef.current = peers
      membersReadyRef.current = true
      void loadPeerNames(peers)

      if (peers.length > 7) {
        setErr('This room is full (max 7 on-camera including you).')
        return
      }

      /* Android settle after previous leave stopped the camera. */
      if (isCapacitorApp()) await sleep(320)

      const acquired = await acquireLocalMedia(backCamRef.current, selectedMicIdRef.current || undefined)
      if (!sessionAlive()) {
        discardMediaStream(acquired.stream)
        return
      }
      stream = acquired.stream
      hasRealCameraRef.current = acquired.hasCamera
      setMediaWarn(acquired.hint)
      if (acquired.hint) setMediaWarnDismissed(false)
      attachLocal(stream)
      if (!sessionAlive()) return
      /* APK: WebRTC defaults to earpiece — force loudspeaker for live rooms. */
      void enableLiveRoomSpeaker()
      stream.getVideoTracks().forEach((t) => {
        t.enabled = !!(camOnRef.current && !ghostRef.current)
      })
      stream.getAudioTracks().forEach((t) => {
        t.enabled = !!micOnRef.current
      })
      if (!acquired.hasCamera && virtualBgRef.current) {
        applyVirtualBackground(virtualBgRef.current)
        setMediaWarn(null)
      }
      void refreshMicDevices()

      const iceQueues = new Map<string, RTCIceCandidateInit[]>()
      const pendingSignals = new Map<string, SigPayload[]>()

      const flushIceQueue = async (remoteId: string, pc: RTCPeerConnection) => {
        const pending = iceQueues.get(remoteId) ?? []
        if (!pending.length) return
        iceQueues.set(remoteId, [])
        for (const candidate of pending) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate))
          } catch (e) {
            console.warn('[ice flush]', remoteId.slice(0, 6), e)
          }
        }
      }

      const queueIceCandidate = async (
        remoteId: string,
        pc: RTCPeerConnection,
        candidate: RTCIceCandidateInit,
      ) => {
        if (!pc.remoteDescription) {
          const q = iceQueues.get(remoteId) ?? []
          q.push(candidate)
          iceQueues.set(remoteId, q)
          return
        }
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      }

      const ensureOutgoingTracks = (pc: RTCPeerConnection) => {
        const live = localStreamRef.current
        if (!live) return
        for (const track of live.getTracks()) {
          if (track.readyState !== 'live') continue
          const sender = pc.getSenders().find((s) => s.track?.kind === track.kind)
          if (sender) {
            if (sender.track !== track) void sender.replaceTrack(track)
          } else {
            try {
              pc.addTrack(track, live)
            } catch (e) {
              console.warn('[addTrack]', e)
            }
          }
        }
      }

      const mergeRemoteStream = (remoteId: string, ev: RTCTrackEvent) => {
        let ms = remoteStreamCacheRef.current.get(remoteId)
        if (!ms) {
          ms = new MediaStream()
          remoteStreamCacheRef.current.set(remoteId, ms)
        }
        if (ev.streams[0]) {
          for (const track of ev.streams[0].getTracks()) {
            if (!ms.getTracks().some((t) => t.id === track.id)) ms.addTrack(track)
          }
        } else if (ev.track && !ms.getTracks().some((t) => t.id === ev.track!.id)) {
          ms.addTrack(ev.track)
        }
        return ms
      }

      /** Tear down one mesh leg. Only drop membership when they actually left the room. */
      const teardownMeshPeer = (remoteId: string, opts?: { leftRoom?: boolean }) => {
        const pc = pcsRef.current.get(remoteId)
        if (pc) {
          try {
            pc.close()
          } catch {
            /* ignore */
          }
          pcsRef.current.delete(remoteId)
        }
        iceQueues.delete(remoteId)
        remoteStreamCacheRef.current.delete(remoteId)
        if (opts?.leftRoom) remoteRtcSidRef.current.delete(remoteId)
        bumpRemote(remoteId, null)
        if (!opts?.leftRoom) return
        setRoomMemberIds((prev) => {
          const next = prev.filter((id) => id !== remoteId)
          if (!stopped) {
            setStatus(
              next.length === 0
                ? 'Solo · second EXE needs a different login (new port opens automatically)'
                : `Live · mesh ${next.length + 1} people`,
            )
          }
          return next
        })
        setStageSlots((prev) => {
          const next = prev.map((slot) => (slot === remoteId ? null : slot))
          if (canManageStageRef.current) {
            void persistAndBroadcastStageRef.current(stageLayoutCountRef.current, next)
          }
          return next
        })
      }

      const removePeer = (remoteId: string) => teardownMeshPeer(remoteId, { leftRoom: true })

      /** Open mesh leg to `remoteId` — uses captured `stream` (same object peers must receive). */
      const attachPeerConnection = (remoteId: string) => {
        if (!sessionAlive()) return
        if (remoteId === me.id || pcsRef.current.has(remoteId)) return
        for (const [id, dead] of [...pcsRef.current.entries()]) {
          if (dead.connectionState === 'closed') pcsRef.current.delete(id)
        }
        if (pcsRef.current.size >= 6) {
          console.warn('[WebRTC] peer cap reached — skip', remoteId.slice(0, 6))
          return
        }
        const live = localStreamRef.current
        if (!live || !localStreamAlive(live)) return
        const pc = new RTCPeerConnection({
          iceServers: rtcIceServers(),
          iceCandidatePoolSize: 4,
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require',
        })
        pcsRef.current.set(remoteId, pc)

        pc.onconnectionstatechange = () => {
          if (stopped || leavingRef.current) return
          const st = pc.connectionState
          if (st === 'failed') {
            console.warn('[WebRTC] connection failed — restarting ICE', remoteId.slice(0, 6))
            try {
              pc.restartIce()
              if (me.id.localeCompare(remoteId) < 0) {
                void (async () => {
                  try {
                    const offer = await pc.createOffer({ iceRestart: true })
                    await pc.setLocalDescription(offer)
                    await sendSignal({ kind: 'offer', sdp: offer, to: remoteId, renog: true })
                  } catch (e) {
                    console.warn('[ice restart offer]', e)
                  }
                })()
              }
            } catch (e) {
              console.warn('[ice restart]', e)
            }
          }
          setStatus(`${remoteId.slice(0, 6)}:${st}`)
        }

        pc.oniceconnectionstatechange = () => {
          if (stopped || leavingRef.current) return
          const ice = pc.iceConnectionState
          if (ice === 'failed') {
            window.setTimeout(() => {
              if (!sessionAlive()) return
              if (pc.iceConnectionState !== 'failed') return
              /* Rebuild this one leg only — do not nuke the whole room. */
              teardownMeshPeer(remoteId)
              attachPeerConnection(remoteId)
              scheduleOfferIfPoller(remoteId, { renog: true, iceRestart: true, force: true })
            }, isCapacitorApp() ? 900 : 1400)
          } else if (ice === 'disconnected') {
            window.setTimeout(() => {
              if (!sessionAlive()) return
              if (pc.iceConnectionState !== 'disconnected') return
              try {
                pc.restartIce()
              } catch {
                /* ignore */
              }
              healMeshRef.current?.()
            }, isCapacitorApp() ? 1800 : 2400)
          }
        }

        pc.ontrack = (ev) => {
          if (!sessionAlive()) return
          const ms = mergeRemoteStream(remoteId, ev)
          bumpRemote(remoteId, ms)
          window.setTimeout(() => {
            replayRoomAudio(roomRootRef.current)
            replayRoomVideos(roomRootRef.current)
          }, 80)
        }

        ensureOutgoingTracks(pc)

        pc.onicecandidate = async (ev) => {
          if (stopped || !ev.candidate) return
          const json = ev.candidate.toJSON()
          if (iceCandidateIsUseless(json)) return
          await sendSignal({ kind: 'ice', candidate: json, to: remoteId })
        }
      }

      const processSignal = async (from: string, raw: SigPayload) => {
        if (!sessionAlive()) return
        if (!from || !raw || from === me.id) return
        if (raw.to && raw.to !== me.id) return

        if (raw.sid) {
          const prevSid = remoteRtcSidRef.current.get(from)
          if (prevSid && prevSid !== raw.sid) {
            /* Peer remounted / hard-healed — rebuild PC only. Do NOT drop membership or stage. */
            teardownMeshPeer(from)
          }
          remoteRtcSidRef.current.set(from, raw.sid)
        }

        const pcExisting = pcsRef.current.get(from)
        if (
          raw.kind === 'offer' &&
          !raw.renog &&
          pcExisting &&
          (pcExisting.connectionState === 'connected' || pcExisting.connectionState === 'connecting') &&
          (pcExisting.iceConnectionState === 'connected' || pcExisting.iceConnectionState === 'completed') &&
          raw.sid &&
          remoteRtcSidRef.current.get(from) === raw.sid
        ) {
          return
        }
        if (!pcsRef.current.has(from)) attachPeerConnection(from)

        const pc = pcsRef.current.get(from)
        if (!pc) {
          /* Local media not ready yet — queue offer/ICE so we don't drop the handshake. */
          const q = pendingSignals.get(from) ?? []
          if (q.length < 40) q.push(raw)
          pendingSignals.set(from, q)
          return
        }
        ensureOutgoingTracks(pc)
        try {
          if (raw.kind === 'offer' && raw.sdp) {
            const polite = me.id.localeCompare(from) > 0
            /* Accept polarity answers OR recovery renegotiation from either side. */
            if (!polite && !raw.renog) return
            if (pc.signalingState !== 'stable') {
              if (!polite) return
              try {
                await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit)
              } catch {
                /* rollback unsupported — ignore glare */
                return
              }
            }
            await pc.setRemoteDescription(new RTCSessionDescription(raw.sdp))
            await flushIceQueue(from, pc)
            ensureOutgoingTracks(pc)
            /* Belt-and-suspenders: setRemoteDescription/flushIceQueue above are async
             * and yield, so a concurrent signal for this same peer could have already
             * moved us on. Bail quietly instead of letting createAnswer() throw
             * InvalidStateError — the peer that's actually still owed an answer will
             * retry via the offer/ICE-restart path already in place below. */
            if (pc.signalingState !== 'have-remote-offer' && pc.signalingState !== 'have-local-pranswer') return
            const ans = await pc.createAnswer()
            if (pc.signalingState !== 'have-remote-offer' && pc.signalingState !== 'have-local-pranswer') return
            await pc.setLocalDescription(ans)
            await sendSignal({ kind: 'answer', sdp: ans, to: from })
            window.setTimeout(() => {
              replayRoomAudio(roomRootRef.current)
              replayRoomVideos(roomRootRef.current)
            }, 100)
          }
          if (raw.kind === 'answer' && raw.sdp) {
            /* Accept answers to our offers (we are offerer, or forced renog). */
            if (me.id.localeCompare(from) < 0 || raw.renog || pc.signalingState === 'have-local-offer') {
              await pc.setRemoteDescription(new RTCSessionDescription(raw.sdp))
              await flushIceQueue(from, pc)
            }
          }
          if (raw.kind === 'ice' && raw.candidate && raw.to === me.id) {
            if (iceCandidateIsUseless(raw.candidate)) return
            await queueIceCandidate(from, pc, raw.candidate)
          }
        } catch (e) {
          console.warn('[WebRTC]', e)
        }
      }

      const flushPendingSignals = async () => {
        if (!sessionAlive() || !localStreamRef.current) return
        for (const [from, queued] of [...pendingSignals.entries()]) {
          pendingSignals.delete(from)
          for (const raw of queued) {
            if (!sessionAlive()) return
            await processSignal(from, raw)
          }
        }
      }

      const scheduleOfferIfPoller = (remoteId: string, opts?: { renog?: boolean; iceRestart?: boolean; force?: boolean }) => {
        if (stopped || leavingRef.current) return
        const iAmOfferer = me.id.localeCompare(remoteId) < 0
        if (!iAmOfferer && !opts?.force) return
        const slot = offerSlot++
        void (async () => {
          await sleep(50 * slot + 50)
          if (!sessionAlive()) return
          if (!pcsRef.current.has(remoteId)) attachPeerConnection(remoteId)
          const pc = pcsRef.current.get(remoteId)
          if (!pc) return
          try {
            ensureOutgoingTracks(pc)
            /* Perfect negotiation: if we already have a local offer and we're the polite peer, skip. */
            if (pc.signalingState !== 'stable' && me.id.localeCompare(remoteId) > 0) return
            const offer = await pc.createOffer(
              opts?.iceRestart ? { iceRestart: true } : undefined,
            )
            await pc.setLocalDescription(offer)
            await sendSignal({
              kind: 'offer',
              sdp: offer,
              to: remoteId,
              renog: opts?.renog || opts?.iceRestart || opts?.force,
            })
          } catch (e) {
            console.warn('[offer]', e)
          }
        })()
      }

      const currentPeerIds = (): string[] => {
        const live = roomMemberIdsRef.current
        return live.length ? live : peers
      }

      const syncMeshPeers = () => {
        if (stopped || leavingRef.current) return
        if (!localStreamRef.current) return
        for (const remoteId of currentPeerIds()) {
          if (remoteId === me.id || pcsRef.current.has(remoteId)) continue
          attachPeerConnection(remoteId)
          scheduleOfferIfPoller(remoteId)
        }
      }
      syncMeshPeersRef.current = syncMeshPeers

      peers.forEach((remoteId) => {
        attachPeerConnection(remoteId)
        scheduleOfferIfPoller(remoteId)
      })
      void flushPendingSignals()

      const lastRenogAt = new Map<string, number>()
      const RENOG_COOLDOWN_MS = renogCooldownMs()

      healMeshRef.current = () => {
        if (stopped || leavingRef.current) return
        syncMeshPeers()
        void flushPendingSignals()
        const now = Date.now()
        for (const remoteId of currentPeerIds()) {
          if (!pcsRef.current.has(remoteId)) attachPeerConnection(remoteId)
          const pc = pcsRef.current.get(remoteId)
          if (!pc) continue
          ensureOutgoingTracks(pc)
          const iceBad =
            pc.connectionState === 'failed' ||
            pc.iceConnectionState === 'failed' ||
            pc.iceConnectionState === 'disconnected'
          const senderDead = pc.getSenders().some((s) => s.track && s.track.readyState === 'ended')
          const remoteMs = remoteStreamCacheRef.current.get(remoteId)
          const missingRemote =
            !remoteMs ||
            !remoteMs.getTracks().some((t) => t.readyState === 'live')
          const connectedOk =
            pc.connectionState === 'connected' &&
            (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')
          if (connectedOk && !iceBad && !senderDead && !missingRemote) continue
          const lastRenog = lastRenogAt.get(remoteId) ?? 0
          const needsUrgent = iceBad || senderDead
          if (!needsUrgent && now - lastRenog < RENOG_COOLDOWN_MS) continue
          /* Either side may renog when media is missing — polarity only for the initial offer. */
          const iAmOfferer = me.id.localeCompare(remoteId) < 0
          if (!iAmOfferer && !missingRemote && !iceBad && !senderDead) continue
          lastRenogAt.set(remoteId, now)
          scheduleOfferIfPoller(remoteId, {
            renog: true,
            iceRestart: iceBad,
            force: missingRemote || iceBad || senderDead,
          })
        }
      }

      /* Realtime quota / dropped INSERT events — poll DB so offers/ICE still land.
       * Same signal can legitimately arrive via 3 paths (live push, backlog replay,
       * this poll) — one shared key set below stops it being processed more than
       * once, which used to race createAnswer()/setLocalDescription() against
       * itself and throw InvalidStateError. */
      let signalCursor = new Date(Date.now() - 8 * 60 * 1000).toISOString()
      const seenSignalKeys = new Set<string>()
      const signalKeyFor = (senderId: string, payload: SigPayload, created: string): string =>
        `${senderId}:${payload.kind}:${payload.to ?? ''}:${created}:${
          payload.kind === 'ice'
            ? String((payload.candidate as { candidate?: string } | undefined)?.candidate ?? '').slice(0, 48)
            : String((payload.sdp as { type?: string } | undefined)?.type ?? '')
        }`
      const markSignalSeen = (key: string): boolean => {
        if (seenSignalKeys.has(key)) return false
        seenSignalKeys.add(key)
        if (seenSignalKeys.size > 800) {
          const drop = [...seenSignalKeys].slice(0, 400)
          for (const k of drop) seenSignalKeys.delete(k)
        }
        return true
      }
      const pollSignals = async () => {
        if (!sessionAlive()) return
        try {
          const { data } = await client
            .from('webrtc_signals')
            .select('sender_id, payload, created_at')
            .eq('room_id', conversationId)
            .gte('created_at', signalCursor)
            .order('created_at', { ascending: true })
            .limit(120)
          for (const row of data ?? []) {
            const created = (row.created_at as string) || signalCursor
            if (created > signalCursor) signalCursor = created
            const payload = row.payload as SigPayload | null
            if (!payload) continue
            if (!markSignalSeen(signalKeyFor((row.sender_id as string) || '', payload, created))) continue
            await processSignal((row.sender_id as string) || '', payload)
          }
        } catch (e) {
          console.warn('[signal poll]', e)
        }
      }

      const refreshPeersFromDb = async () => {
        if (!sessionAlive()) return
        try {
          const { data } = await client
            .from('conversation_members')
            .select('user_id')
            .eq('conversation_id', conversationId)
          if (!sessionAlive()) return
          const nextPeers = peerIdsFromMembers(data as { user_id: string }[] | null)
          const prev = roomMemberIdsRef.current.join(',')
          const next = nextPeers.join(',')
          if (prev === next) {
            syncMeshPeers()
            return
          }
          peers = nextPeers
          roomMemberIdsRef.current = nextPeers
          setRoomMemberIds(nextPeers)
          void loadPeerNames(nextPeers)
          for (const remoteId of nextPeers) {
            if (pcsRef.current.has(remoteId)) continue
            attachPeerConnection(remoteId)
            scheduleOfferIfPoller(remoteId)
          }
          syncMeshPeers()
        } catch {
          /* ignore */
        }
      }

      let signalPollTimerLocal: number | null = null
      let signalPollFastTimer: number | null = null
      const signalPollMs = signalPollSteadyMs()
      const runSignalPoll = () => {
        if (!sessionAlive()) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        void pollSignals()
      }
      runSignalPoll()
      signalPollFastTimer = window.setInterval(runSignalPoll, signalPollFastMs())
      window.setTimeout(() => {
        if (signalPollFastTimer != null) {
          window.clearInterval(signalPollFastTimer)
          signalPollFastTimer = null
        }
      }, signalPollFastDurationMs())
      signalPollTimerLocal = window.setInterval(runSignalPoll, signalPollMs)
      signalPollTimer = signalPollTimerLocal

      /* Keep mesh alive quietly — heal only when a leg looks unhealthy (avoids renog stampede). */
      meshWatch = window.setInterval(() => {
        if (!sessionAlive()) return
        const backgrounded = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        void flushPendingSignals()
        if (backgrounded) return
        let needsHeal = false
        for (const remoteId of currentPeerIds()) {
          const pc = pcsRef.current.get(remoteId)
          if (!pc) {
            needsHeal = true
            break
          }
          const remoteMs = remoteStreamCacheRef.current.get(remoteId)
          const missingRemote =
            !remoteMs || !remoteMs.getTracks().some((t) => t.readyState === 'live')
          const iceBad =
            pc.connectionState === 'failed' ||
            pc.iceConnectionState === 'failed' ||
            pc.iceConnectionState === 'disconnected'
          const connectedOk =
            pc.connectionState === 'connected' &&
            (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')
          if (!connectedOk || missingRemote || iceBad) {
            needsHeal = true
            break
          }
        }
        if (needsHeal) healMeshRef.current?.()
      }, meshWatchIntervalMs())

      resumeRtcRef.current = async (opts) => {
        if (!sessionAlive()) return
        if (resumeInFlightRef.current) return
        resumeInFlightRef.current = true
        const soft = opts?.soft === true
        const forceRemount = opts?.remount === true
        let didReacquire = false
        let rebuiltFailedLeg = false
        let missingRemoteMedia = false
        try {
        let s = localStreamRef.current
        const videoLive = !!s?.getVideoTracks().some((t) => t.readyState === 'live')
        const audioLive = !!s?.getAudioTracks().some((t) => t.readyState === 'live')
        const needFresh =
          !localStreamAlive(s) || (camOnRef.current && !ghostRef.current && !videoLive && !audioLive)

        if (needFresh) {
          didReacquire = true
          try {
            /* Prefer last camera deviceId so resume does not flip front/back. */
            let acquired: { stream: MediaStream; hint: string | null; hasCamera: boolean }
            const preferId = lastVideoDeviceIdRef.current
            if (preferId && camOnRef.current) {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({
                  audio: selectedMicIdRef.current
                    ? { deviceId: { ideal: selectedMicIdRef.current } }
                    : true,
                  video: { deviceId: { ideal: preferId } },
                })
                acquired = { stream, hint: null, hasCamera: stream.getVideoTracks().length > 0 }
              } catch {
                acquired = await acquireLocalMedia(backCamRef.current, selectedMicIdRef.current || undefined)
              }
            } else {
              acquired = await acquireLocalMedia(backCamRef.current, selectedMicIdRef.current || undefined)
            }
            if (!sessionAlive()) {
              discardMediaStream(acquired.stream)
              return
            }
            s = acquired.stream
            hasRealCameraRef.current = acquired.hasCamera
            attachLocal(s)
            if (!sessionAlive()) return
            void enableLiveRoomSpeaker()
            s.getVideoTracks().forEach((t) => {
              t.enabled = !!(camOnRef.current && !ghostRef.current)
            })
            s.getAudioTracks().forEach((t) => {
              t.enabled = !!micOnRef.current
            })
          } catch (e) {
            console.warn('[resume media]', e)
          }
        } else if (s) {
          void enableLiveRoomSpeaker()
          /* Soft resume only — never flip facing / never re-pick random camera. */
          if (camOnRef.current && !ghostRef.current && !videoLive) {
            didReacquire = true
            const preferId = lastVideoDeviceIdRef.current
            const vt = preferId
              ? await (async () => {
                  try {
                    const probe = await navigator.mediaDevices.getUserMedia({
                      audio: false,
                      video: { deviceId: { ideal: preferId } },
                    })
                    const [track] = probe.getVideoTracks()
                    probe.getAudioTracks().forEach((t) => t.stop())
                    return track ?? null
                  } catch {
                    return acquireVideoTrackForFacing(backCamRef.current)
                  }
                })()
              : await acquireVideoTrackForFacing(backCamRef.current)
            if (vt && sessionAlive()) {
              const dead = s.getVideoTracks().filter((t) => t.readyState !== 'live')
              for (const old of dead) {
                s.removeTrack(old)
                old.stop()
              }
              vt.enabled = true
              if (!s.getVideoTracks().includes(vt)) s.addTrack(vt)
              const vid = vt.getSettings?.()?.deviceId
              if (vid) lastVideoDeviceIdRef.current = vid
              setLocalStream(s)
              pcsRef.current.forEach((pc) => {
                const snd = pc.getSenders().find((x) => x.track?.kind === 'video')
                if (snd) void snd.replaceTrack(vt)
                else pc.addTrack(vt, s!)
              })
            }
          }
          s.getVideoTracks().forEach((t) => {
            t.enabled = !!(camOnRef.current && !ghostRef.current)
          })
          s.getAudioTracks().forEach((t) => {
            t.enabled = !!micOnRef.current
          })
        }

        if (!sessionAlive()) return

        void resumeSharedAudioContext()
        replayRoomVideos(roomRootRef.current)
        replayRoomAudio(roomRootRef.current)
        await flushPendingSignals()
        await pollSignals()

        const live = localStreamRef.current
        if (live && localStreamAlive(live)) {
          pcsRef.current.forEach((pc) => {
            ensureOutgoingTracks(pc)
            live.getTracks().forEach((track) => {
              const snd = pc.getSenders().find((x) => x.track?.kind === track.kind)
              if (snd && snd.track !== track) void snd.replaceTrack(track)
            })
          })
        }

        /* Rebuild dead legs + renog when remote media is missing (common after Home). */
        for (const remoteId of currentPeerIds()) {
          const pc = pcsRef.current.get(remoteId)
          const remoteMs = remoteStreamCacheRef.current.get(remoteId)
          const noRemote =
            !remoteMs || !remoteMs.getTracks().some((t) => t.readyState === 'live')
          if (noRemote) missingRemoteMedia = true
          const iceFailed =
            !!pc &&
            (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed')
          if (!pc || iceFailed) {
            rebuiltFailedLeg = true
            teardownMeshPeer(remoteId)
            attachPeerConnection(remoteId)
            scheduleOfferIfPoller(remoteId, { renog: true, iceRestart: true, force: true })
          } else if (noRemote) {
            scheduleOfferIfPoller(remoteId, { renog: true, iceRestart: true, force: true })
          }
        }
        /*
         * Always heal after resume when remotes missing / legs rebuilt.
         * Soft only skips DOM remount — never skip mesh repair (that left "only my cam").
         */
        if (!soft || rebuiltFailedLeg || missingRemoteMedia || didReacquire) {
          healMeshRef.current?.()
        } else {
          /* Soft + healthy: still sync any new peer ids. */
          syncMeshPeers()
        }
        /*
         * Remount video DOM only when forced or media was reacquired (local blank tiles).
         * Soft Home-return with healthy tracks: replay only — never flash the stage for peers.
         */
        const shouldRemount = forceRemount || didReacquire
        if (shouldRemount) {
          setVideoEpoch((n) => n + 1)
        }
        scheduleRoomWork('media-replay-boot', () => {
          replayRoomVideos(roomRootRef.current)
          replayRoomAudio(roomRootRef.current)
        }, 220)
        window.setTimeout(() => {
          replayRoomVideos(roomRootRef.current)
          replayRoomAudio(roomRootRef.current)
        }, 600)
        } finally {
          resumeInFlightRef.current = false
        }
      }

      const rtcTopic = `rtc:${conversationId}:${me.id}`
      for (const ch of client.getChannels()) {
        if (ch.topic === `realtime:${rtcTopic}`) {
          await client.removeChannel(ch)
        }
      }

      const chan = client
        .channel(rtcTopic)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'webrtc_signals',
            filter: `room_id=eq.${conversationId}`,
          },
          async (evt) => {
            const row = evt.new as { sender_id?: string; payload?: SigPayload; created_at?: string }
            const payload = row.payload
            if (!payload) return
            const created = row.created_at || new Date().toISOString()
            if (!markSignalSeen(signalKeyFor(row.sender_id ?? '', payload, created))) return
            await processSignal(row.sender_id ?? '', payload)
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'conversation_members',
            filter: `conversation_id=eq.${conversationId}`,
          },
          async (evt) => {
            const row = evt.new as { user_id?: string }
            if (stopped || !row.user_id) return

            const res = await client
              .from('conversation_members')
              .select('user_id')
              .eq('conversation_id', conversationId)
            if (stopped) return
            const nextPeers = peerIdsFromMembers(res.data)
            if (nextPeers.length > 7) {
              setErr('This room is full (max 7 on-camera including you).')
              return
            }

            for (const remoteId of nextPeers) {
              if (pcsRef.current.has(remoteId)) continue
              attachPeerConnection(remoteId)
              scheduleOfferIfPoller(remoteId)
            }
            peers = nextPeers
            roomMemberIdsRef.current = nextPeers
            setRoomMemberIds(nextPeers)
            void loadPeerNames(nextPeers)
            void loadRoomRolesRef.current({ hydrateStage: false })
            if (canManageStageRef.current && row.user_id !== me.id) {
              const pushStage = () => {
                void persistAndBroadcastStageRef.current(
                  stageLayoutCountRef.current,
                  stageSlotsRef.current,
                )
              }
              /* Late joiners often miss the first broadcast — retry so EXE/APK both get slots. */
              pushStage()
              window.setTimeout(pushStage, 500)
              window.setTimeout(pushStage, 1600)
            }
            if (!stopped) {
              setStatus(
                nextPeers.length === 0
                  ? 'Solo · second EXE needs a different login (new port opens automatically)'
                  : nextPeers.length >= 6
                    ? `Live · mesh ${nextPeers.length + 1} people`
                    : 'Connecting…',
              )
            }
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'DELETE',
            schema: 'public',
            table: 'conversation_members',
            filter: `conversation_id=eq.${conversationId}`,
          },
          (evt) => {
            const row = evt.old as { user_id?: string }
            const leftId = row.user_id
            if (stopped || !leftId) return
            if (leftId === me.id) {
              setErr('You were removed from this room by the host.')
              /* Do not pre-set leavingRef here — leaveToLobby() sets it itself right
               * after its own reentrancy guard, and setting it early made that guard
               * trip on this very call, leaving the screen stuck with the error
               * banner and every button dead (Lobby included). */
              window.setTimeout(() => leaveToLobby(), 0)
              return
            }
            removePeer(leftId)
            void loadRoomRolesRef.current({ hydrateStage: false })
          },
        )

      subscribedChan = chan
      await chan.subscribe()

      // Replay offers/ICE that arrived before realtime subscription (common when APK joins after EXE).
      if (!stopped) {
        const since = new Date(Date.now() - 8 * 60 * 1000).toISOString()
        const { data: backlog } = await client
          .from('webrtc_signals')
          .select('sender_id, payload, created_at')
          .eq('room_id', conversationId)
          .gte('created_at', since)
          .order('created_at', { ascending: true })
          .limit(400)
        for (const row of backlog ?? []) {
          if (stopped) break
          const payload = row.payload as SigPayload | null
          if (!payload) continue
          const created = (row.created_at as string) || since
          if (!markSignalSeen(signalKeyFor((row.sender_id as string) || '', payload, created))) continue
          await processSignal(row.sender_id as string, payload)
        }
        await flushPendingSignals()
        scheduleRoomWork('mesh-boot', () => healMeshRef.current?.(), 120)
        scheduleRoomWork('mesh-boot-2', () => healMeshRef.current?.(), 900)
      }

      if (!stopped)
        setStatus(
          peers.length === 0
            ? 'Solo · second EXE needs a different login (new port opens automatically)'
            : peers.length > 6
              ? `Live · mesh ${peers.length + 1} people`
              : 'Connecting…',
        )
    }

    void run()

    return () => {
      stopped = true
      cancelAllRoomWork()
      if (meshWatch != null) window.clearInterval(meshWatch)
      if (signalPollTimer != null) window.clearInterval(signalPollTimer)
      if (signalPollFastTimer != null) window.clearInterval(signalPollFastTimer)
      resumeRtcRef.current = null
      healMeshRef.current = null
      syncMeshPeersRef.current = null
      if (subscribedChan) client.removeChannel(subscribedChan)

      closePeerConnections(pcsRef.current)
      remoteStreamCacheRef.current.clear()
      setRemoteStreams({})

      /* Safety net: if user navigated away without Lobby (back button, crash retry), drop DB membership. */
      const cid = conversationId
      if (
        cid &&
        roomKindRef.current === 'live' &&
        liveMemberRef.current &&
        !membershipLeftRef.current &&
        !switchingRoomRef.current &&
        !leavingRef.current
      ) {
        void leaveLiveRoomMembership(cid, me.id).then((ok) => {
          if (ok) {
            liveMemberRef.current = false
            membershipLeftRef.current = true
          }
        })
      }

      /* Always release camera/mic on unmount (including Retry) so Android can re-acquire. */
      if (rtcRestartRef.current) rtcRestartRef.current = false
      void restoreRoomAudio()
      if (mediaReleasedRef.current) return
      mediaReleasedRef.current = true
      stopBgFeed()
      document.querySelectorAll('.battle-fx-portal').forEach((node) => node.remove())
      detachRoomMediaElements(roomRootRef.current)
      discardMediaStream(localStreamRef.current)
      localStreamRef.current = null
      setLocalStream(null)
    }
  }, [conversationId, me.id, rtcBootKey])

  useEffect(() => {
    roomMemberIdsRef.current = roomMemberIds
    syncMeshPeersRef.current?.()
  }, [roomMemberIds])

  useEffect(() => {
    if (!conversationId) return

    let resumeTimer: number | null = null
    const queueResume = (soft: boolean) => {
      if (leavingRef.current || mediaReleasedRef.current) return
      if (soft && isCapacitorApp()) {
        const now = Date.now()
        /* appStateChange already soft-resumed — skip duplicate visibility/focus flash. */
        if (now - lastHomeResumeAtRef.current < 1400) return
        lastHomeResumeAtRef.current = now
      }
      if (resumeTimer) clearTimeout(resumeTimer)
      resumeTimer = window.setTimeout(() => {
        resumeTimer = null
        if (leavingRef.current || mediaReleasedRef.current) return
        void resumeRtcRef.current?.(soft ? { soft: true } : undefined)
      }, soft && isCapacitorApp() ? 280 : isCapacitorApp() ? 800 : 250)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') queueResume(isCapacitorApp())
    }
    const onFocusOrShow = () => queueResume(isCapacitorApp())

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocusOrShow)
    window.addEventListener('pageshow', onFocusOrShow)

    return () => {
      if (resumeTimer) clearTimeout(resumeTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocusOrShow)
      window.removeEventListener('pageshow', onFocusOrShow)
    }
  }, [conversationId])

  async function switchMic(deviceId: string) {
    setSelectedMicId(deviceId)
    selectedMicIdRef.current = deviceId
    const s = localStreamRef.current
    if (!s) return
    try {
      const probe = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
        video: false,
      })
      const [newAudio] = probe.getAudioTracks()
      const [oldAudio] = s.getAudioTracks()
      if (oldAudio) {
        s.removeTrack(oldAudio)
        oldAudio.stop()
      }
      newAudio.enabled = !!micOnRef.current
      replaceOutgoingAudioTrack(newAudio)
    } catch {
      setMediaWarn('Could not switch microphone — check site permissions.')
    }
  }

  function onVirtualBgPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      alert('Choose an image file (JPG, PNG, or WebP).')
      return
    }
    if (file.size > VIRTUAL_BG_MAX_BYTES) {
      alert('Image too large — use a file under 1.5 MB.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : null
      if (!url) return
      try {
        localStorage.setItem(VIRTUAL_BG_STORAGE_KEY, url)
      } catch {
        /* still apply for this session */
      }
      applyVirtualBackground(url)
      setMediaWarn(null)
    }
    reader.readAsDataURL(file)
  }

  function clearVirtualBg() {
    try {
      localStorage.removeItem(VIRTUAL_BG_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    applyVirtualBackground(null)
  }

  async function flipCamera() {
    const s = localStreamRef.current
    if (!s) return
    const wantBack = !backCamRef.current
    const prevBack = backCamRef.current
    const oldVideoTracks = [...s.getVideoTracks()]
    const camOnNow = !!(camOn && !ghostMode)

    let vt = await acquireVideoTrackForFacing(wantBack)

    if (!vt && oldVideoTracks.length > 0) {
      for (const old of oldVideoTracks) {
        s.removeTrack(old)
        old.stop()
      }
      await new Promise((r) => window.setTimeout(r, isCapacitorApp() ? 450 : 200))
      vt = await acquireVideoTrackForFacing(wantBack)
    }

    if (!vt) {
      if (oldVideoTracks.length > 0) {
        const restore = await acquireVideoTrackForFacing(prevBack)
        if (restore) {
          restore.enabled = camOnNow
          s.addTrack(restore)
          for (const ref of [localRef, localMiniRef, localSelfPipRef]) {
            const el = ref.current
            if (!el) continue
            el.srcObject = s
            void el.play().catch(() => {})
          }
          pcsRef.current.forEach((pc) => {
            const snd = pc.getSenders().find((x) => x.track?.kind === 'video')
            if (snd) void snd.replaceTrack(restore)
          })
        }
      }
      setMediaWarn('Could not flip camera — try again in a moment.')
      return
    }

    vt.enabled = camOnNow
    for (const old of oldVideoTracks) {
      if (s.getVideoTracks().includes(old)) s.removeTrack(old)
      if (old.readyState !== 'ended') old.stop()
    }
    if (!s.getVideoTracks().includes(vt)) s.addTrack(vt)

    backCamRef.current = wantBack
    setFacingBack(wantBack)
    hasRealCameraRef.current = true
    const vid = vt.getSettings?.()?.deviceId
    if (vid) lastVideoDeviceIdRef.current = vid
    stopBgFeed()
    setMediaWarn(null)

    pcsRef.current.forEach((pc) => {
      const snd = pc.getSenders().find((x) => x.track?.kind === 'video')
      if (snd) void snd.replaceTrack(vt)
    })

    for (const ref of [localRef, localMiniRef, localSelfPipRef]) {
      const el = ref.current
      if (!el) continue
      el.srcObject = s
      void el.play().catch(() => {})
    }
  }

  function retryRealtimeAndMedia() {
    rtcRestartRef.current = true
    setRtcBootKey((n) => n + 1)
  }

  const remoteIds = Object.keys(remoteStreams)
  const remoteOrder =
    pinnedPeer && remoteIds.includes(pinnedPeer)
      ? [pinnedPeer, ...remoteIds.filter((id) => id !== pinnedPeer)]
      : remoteIds
  remoteOrderRef.current = remoteOrder

  function releaseLocalMedia() {
    if (mediaReleasedRef.current) return
    mediaReleasedRef.current = true
    closePeerConnections(pcsRef.current)
    remoteStreamCacheRef.current.clear()
    setRemoteStreams({})
    stopBgFeed()
    document.querySelectorAll('.battle-fx-portal').forEach((node) => node.remove())
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    setLocalStream(null)
  }

  function peerLabel(pid: string) {
    const name = peerNames[pid]?.trim()
    if (name) return name
    return `Member ${pid.slice(-4)}`
  }

  useEffect(() => {
    if (me.avatar_url?.trim()) {
      setPeerAvatars((prev) => (prev[me.id] === me.avatar_url ? prev : { ...prev, [me.id]: me.avatar_url!.trim() }))
    }
  }, [me.id, me.avatar_url])

  const isLiveRoom = titles.kind === 'live'
  const canManageStage = isLiveRoom && canAdminLiveStage(myRoomRole)
  const isRoomHost = myRoomRole === 'host'
  canManageStageRef.current = canManageStage

  const layoutFromManager = useCallback((senderId?: string) => {
    if (!senderId) return false
    if (senderId === roomCreatorIdRef.current) return true
    if (memberRolesRef.current[senderId] === 'host') return true
    return canAdminLiveStage(memberRolesRef.current[senderId] ?? 'member')
  }, [])

  const applySyncedStage = useCallback(
    (camCount: number, userSlots?: (string | null)[]) => {
      const count = clampCamLayout(camCount)
      const normalized = [...(userSlots ?? []).slice(0, count)]
      while (normalized.length < count) normalized.push(null)
      const fp = stageLayoutFingerprint(count, normalized)
      if (fp === stageFingerprintRef.current) return
      stageFingerprintRef.current = fp
      setStageLayoutCount(count)
      const feeds = stageFeedsFromUserIds(normalized, me.id)
      setStageSlots(feeds.slice(0, count))
    },
    [me.id],
  )

  applySyncedStageRef.current = applySyncedStage

  const applyHostMutedIds = useCallback(
    (ids: string[]) => {
      const next = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
      setHostMutedIds(next)
      hostMutedIdsRef.current = new Set(next)
      if (next.includes(me.id)) {
        setMicOn(false)
        applyMicEnabled(false)
      }
    },
    [me.id],
  )

  const applyLayoutPayload = useCallback(
    (payload: RoomLayoutSync) => {
      if (typeof payload.royale === 'boolean') {
        setRoyaleActive(payload.royale)
        if (!payload.royale) {
          setRoyaleEliminated([])
          setRoyaleWinnerTeam(null)
        }
        // Capacity pills control 2–7; don't remount into an alternate grid layout.
      }
      if (typeof payload.camCount === 'number') {
        applySyncedStage(payload.camCount, payload.stageSlots)
      } else if (Array.isArray(payload.stageSlots)) {
        applySyncedStage(stageLayoutCountRef.current, payload.stageSlots)
      }
      if (Array.isArray(payload.mutedUserIds)) {
        applyHostMutedIds(payload.mutedUserIds)
      }
    },
    [applySyncedStage, applyHostMutedIds],
  )

  const persistAndBroadcastStage = useCallback(
    async (count: number, slots: StageFeed[]) => {
      if (!conversationId || !supabase || !canManageStageRef.current) return
      const camCount = clampCamLayout(count)
      const trimmed = [...slots.slice(0, camCount)]
      while (trimmed.length < camCount) trimmed.push(null)
      const userSlots = stageFeedsToUserIds(trimmed, me.id)
      const { error } = await supabase.rpc('set_live_stage', {
        p_conversation_id: conversationId,
        p_cam_count: camCount,
        p_slots: userSlots,
      })
      if (error) {
        console.warn('[stage persist]', error.message, '— broadcasting layout only (run FIX_LIVE_ROOM_MODERATORS.sql for DB sync)')
      }
      layoutSyncRef.current?.broadcast({
        from: me.id,
        camCount,
        stageSlots: userSlots,
        mutedUserIds: [...hostMutedIdsRef.current],
      } satisfies RoomLayoutSync)
    },
    [conversationId, me.id],
  )

  const applyHostRole = useCallback(
    (creatorId: string | null, role: LiveRoomRole, modsOn: boolean) => {
      const mine: LiveRoomRole =
        creatorId === me.id || role === 'host' ? 'host' : role
      setRoomCreatorId(creatorId)
      roomCreatorIdRef.current = creatorId
      setModsEnabled(modsOn)
      modsEnabledRef.current = modsOn
      setMyRoomRole(mine)
      canManageStageRef.current = canAdminLiveStage(mine)
      if (mine === 'host') {
        const roles = { ...memberRolesRef.current, [me.id]: 'host' as LiveRoomRole }
        memberRolesRef.current = roles
        setMemberRoles(roles)
      }
    },
    [me.id],
  )

  const loadRoomRoles = useCallback(async (opts?: { hydrateStage?: boolean }) => {
    if (!conversationId || !supabase) return
    const client = supabase

    let conv: Record<string, unknown> | null = null
    const full = await client
      .from('conversations')
      .select('creator_id, mods_enabled, live_cam_count, live_stage_slots, kind')
      .eq('id', conversationId)
      .maybeSingle()
    if (full.error) {
      const basic = await client
        .from('conversations')
        .select('creator_id, kind')
        .eq('id', conversationId)
        .maybeSingle()
      conv = (basic.data as Record<string, unknown> | null) ?? null
    } else {
      conv = (full.data as Record<string, unknown> | null) ?? null
    }

    if (!conv || conv.kind !== 'live') return

    const creatorId = (conv.creator_id as string | null | undefined) ?? null
    const modsOn = conv.mods_enabled !== false

    let members: { user_id: string; role?: string }[] = []
    const withRole = await client
      .from('conversation_members')
      .select('user_id, role')
      .eq('conversation_id', conversationId)
    if (withRole.error) {
      const basic = await client
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', conversationId)
      members = (basic.data ?? []) as { user_id: string }[]
    } else {
      members = (withRole.data ?? []) as { user_id: string; role?: string }[]
    }

    const roles: Record<string, LiveRoomRole> = {}
    let mine: LiveRoomRole = creatorId === me.id ? 'host' : 'member'
    const memberSet = new Set<string>()
    for (const row of members) {
      const uid = row.user_id
      memberSet.add(uid)
      const r = roleFromDb(row.role, creatorId, uid)
      roles[uid] = r
      if (uid === me.id) mine = r
    }
    if (creatorId === me.id) mine = 'host'
    else if (mine !== 'host' && creatorId) {
      /* DB role can lag after cleanup — creator_id is source of truth for room admin. */
      const hostUid = findLiveHostUserId(roles, creatorId, memberSet)
      if (hostUid === me.id) mine = 'host'
    }

    const peerIds = [...memberSet]
      .filter((id) => id !== me.id)
      .sort((a, b) => a.localeCompare(b))
    setRoomMemberIds(peerIds)
    roomMemberIdsRef.current = peerIds
    void loadPeerNames(peerIds)

    setMemberRoles(roles)
    memberRolesRef.current = roles
    applyHostRole(creatorId, mine, modsOn)

    const pending = pendingLayoutSyncRef.current
    if (pending?.from && layoutFromManager(pending.from)) {
      pendingLayoutSyncRef.current = null
      suppressLayoutSyncRef.current = true
      applyLayoutPayload(pending)
      window.setTimeout(() => {
        suppressLayoutSyncRef.current = false
      }, 400)
    }

    const shouldHydrateStage = opts?.hydrateStage ?? !stageHydratedRef.current
    if (!shouldHydrateStage) return

    stageHydratedRef.current = true
    const camCount = (conv.live_cam_count as number | undefined) ?? 2
    let persisted = parseLiveStageSlots(conv.live_stage_slots)
    if (!hasPersistedStageLayout(conv.live_cam_count, persisted)) {
      const stageRow = await client
        .from('conversations')
        .select('live_cam_count, live_stage_slots')
        .eq('id', conversationId)
        .maybeSingle()
      if (!stageRow.error && stageRow.data) {
        persisted = parseLiveStageSlots(stageRow.data.live_stage_slots)
      }
    }
    const syncedAlready = stageSlotsRef.current.some((s) => s !== null)
    membersReadyRef.current = true

    if (hasPersistedStageLayout(conv.live_cam_count, persisted) || persisted.some((s) => s !== null)) {
      /* Keep persisted user ids even if members list is still catching up — pruning handles leavers later. */
      let slots = persisted.map((id) => (typeof id === 'string' && id.length > 0 ? id : null))
      const targetCount = clampCamLayout(camCount)
      while (slots.length < targetCount) slots.push(null)
      slots = slots.slice(0, targetCount)
      if (mine === 'host' && !slots.includes(me.id)) {
        slots = [me.id, ...slots.filter((s) => s && s !== me.id)].slice(0, targetCount)
        while (slots.length < targetCount) slots.push(null)
      }
      applySyncedStage(targetCount, slots)
      if (mine === 'host' && (persisted.some((id) => id && !memberSet.has(id)) || !persisted.includes(me.id))) {
        const stageFeeds: StageFeed[] = slots.map((id) => (id === me.id ? '__local' : id))
        void persistAndBroadcastStage(targetCount, stageFeeds)
      }
    } else if (mine === 'host') {
      /* Default new lives to full 7-window stage; host can shrink via capacity pills. */
      const emptySeven: (string | null)[] = [me.id, null, null, null, null, null, null]
      applySyncedStage(7, emptySeven)
      void persistAndBroadcastStage(7, ['__local', null, null, null, null, null, null])
    } else if (syncedAlready) {
      /* Realtime layout from host arrived before DB hydrate — keep it. */
    } else {
      const guestCount = clampCamLayout((conv.live_cam_count as number | undefined) ?? camCount ?? 2)
      const hostUid =
        findLiveHostUserId(roles, creatorId, memberSet, me.id) ??
        (creatorId && creatorId !== me.id ? creatorId : null)
      const slots: (string | null)[] = Array.from({ length: guestCount }, () => null)
      if (hostUid) slots[0] = hostUid
      for (let i = 0; i < Math.min(persisted.length, guestCount); i++) {
        const id = persisted[i]
        if (id && id !== me.id && memberSet.has(id)) slots[i] = slots[i] ?? id
      }
      applySyncedStage(guestCount, slots)
    }
  }, [applyHostRole, applyLayoutPayload, applySyncedStage, conversationId, layoutFromManager, me.id, persistAndBroadcastStage, loadPeerNames])

  loadRoomRolesRef.current = loadRoomRoles
  persistAndBroadcastStageRef.current = persistAndBroadcastStage

  useEffect(() => {
    if (!conversationId || !isLiveRoom) return
    /* Roles only — stage layout is hydrated after join_live_room in the session bootstrap. */
    void loadRoomRoles({ hydrateStage: false })
  }, [conversationId, isLiveRoom, loadRoomRoles])

  /** Drop anyone who left the room from stage slots; host persists so all clients sync. */
  useEffect(() => {
    if (!isLiveRoom || !membersReadyRef.current) return
    /* Include self — roomMemberIds is peers-only. Never prune against an empty peer list alone. */
    const online = new Set<string>([me.id, ...roomMemberIds])
    if (online.size <= 1 && roomMemberIds.length === 0) {
      /* Solo only if mesh also empty — otherwise members list is still catching up. */
      const meshBusy =
        pcsRef.current.size > 0 ||
        remoteStreamCacheRef.current.size > 0 ||
        Object.keys(remoteStreams).length > 0
      if (meshBusy) return
      setStageSlots((prev) => {
        let changed = false
        const next = prev.map((slot) => {
          if (slot === null || slot === '__local' || slot === me.id) return slot === me.id ? '__local' : slot
          changed = true
          return null
        })
        if (changed && canManageStageRef.current) {
          void persistAndBroadcastStageRef.current(stageLayoutCountRef.current, next)
        }
        return changed ? next : prev
      })
      return
    }
    setStageSlots((prev) => {
      let changed = false
      const next = prev.map((slot) => {
        if (slot === null || slot === '__local') return slot
        if (slot === me.id) return '__local'
        if (!online.has(slot)) {
          /* Keep stage assignment if we still have an active mesh/stream to them. */
          if (pcsRef.current.has(slot) || remoteStreamCacheRef.current.has(slot) || remoteStreams[slot]) {
            return slot
          }
          changed = true
          return null
        }
        return slot
      })
      if (changed && canManageStageRef.current) {
        void persistAndBroadcastStageRef.current(stageLayoutCountRef.current, next)
      }
      return changed ? next : prev
    })
    setStageRequestIds((prev) => prev.filter((id) => id === me.id || online.has(id)))
  }, [isLiveRoom, roomMemberIds, me.id, remoteStreams])

  /** Host / room admin must always occupy a stage frame — never float as APK PIP outside the grid. */
  useEffect(() => {
    const isRoomAdmin =
      canManageStage || roomCreatorIdRef.current === me.id || myRoomRole === 'host'
    if (!isLiveRoom || !isRoomAdmin || !stageHydratedRef.current) return
    const slots = stageSlotsRef.current
    if (slots.includes('__local') || slots.includes(me.id)) {
      hostStageEnsuredRef.current = true
      return
    }
    const filled = slots.filter((s) => s !== null).length
    let count = clampCamLayout(stageLayoutCountRef.current)
    if (filled >= count) count = nextCamLayout(count)
    const others = slots.filter((s): s is string => typeof s === 'string' && s !== '__local' && s !== me.id)
    const next: StageFeed[] = ['__local', ...others].slice(0, count)
    while (next.length < count) next.push(null)
    const fp = stageLayoutFingerprint(count, stageFeedsToUserIds(next, me.id))
    if (fp === stageFingerprintRef.current) return
    hostStageEnsuredRef.current = true
    suppressLayoutSyncRef.current = true
    stageFingerprintRef.current = fp
    setStageLayoutCount(count)
    setStageSlots(next)
    if (roomCreatorIdRef.current === me.id || myRoomRole === 'host') {
      canManageStageRef.current = true
    }
    void persistAndBroadcastStage(count, next)
    window.setTimeout(() => {
      suppressLayoutSyncRef.current = false
    }, 400)
  }, [isLiveRoom, canManageStage, myRoomRole, me.id, stageSlots, stageLayoutCount, persistAndBroadcastStage])

  useEffect(() => {
    if (!conversationId || titles.kind !== 'live') return
    let cancelled = false

    void (async () => {
      layoutSyncRef.current?.detach()
      layoutSyncRef.current = null
      await new Promise((r) => window.setTimeout(r, 0))
      if (cancelled) return
      layoutSyncRef.current = attachRoomLayoutSync(
        conversationId,
        (payload) => {
        if (payload.from === me.id) return
        if (payload.from && !layoutFromManager(payload.from)) {
          pendingLayoutSyncRef.current = payload
          return
        }
        pendingLayoutSyncRef.current = null
        suppressLayoutSyncRef.current = true
        applyLayoutPayload(payload)
        window.setTimeout(() => {
          suppressLayoutSyncRef.current = false
        }, 400)
      },
        (req) => {
          if (req.action === 'request') {
            setStageRequestIds((prev) => (prev.includes(req.from) ? prev : [...prev, req.from]))
              if (canManageStageRef.current && req.from !== me.id) {
              if (stageSlotsRef.current.includes(req.from)) return
              addFeedToStageRef.current(req.from, { fromPeopleList: true })
              setStageRequestIds((prev) => prev.filter((id) => id !== req.from))
              window.setTimeout(() => {
                nudgeMeshRef.current(40)
              }, 200)
            }
          } else {
            setStageRequestIds((prev) => prev.filter((id) => id !== req.from))
          }
        },
        (like) => {
          if (like.from === me.id) return
          setLikes((n) => n + like.delta)
        },
        (mute: HostMuteSync) => {
          if (mute.from === me.id) return
          if (!layoutFromManager(mute.from)) return
          if (Array.isArray(mute.mutedUserIds)) {
            applyHostMutedIds(mute.mutedUserIds)
            return
          }
          const next = new Set(hostMutedIdsRef.current)
          if (mute.muted) next.add(mute.targetUserId)
          else next.delete(mute.targetUserId)
          applyHostMutedIds([...next])
        },
      )
    })()

    return () => {
      cancelled = true
      layoutSyncRef.current?.detach()
      layoutSyncRef.current = null
    }
  }, [conversationId, titles.kind, me.id, applyLayoutPayload, applySyncedStage, layoutFromManager, applyHostMutedIds])

  function broadcastRoomLike(delta = 1) {
    layoutSyncRef.current?.broadcastLike({ from: me.id, delta })
    queueLiveLikeLog(delta)
  }

  function broadcastRoomLayout(next: RoomLayoutSync) {
    if (suppressLayoutSyncRef.current || !canManageStageRef.current) return
    layoutSyncRef.current?.broadcast({ ...next, from: me.id })
  }

  function setCamLayoutCount(next: number) {
    if (!canManageStageRef.current) return
    /* Battle Royale needs the full 7-cam board — don't shrink mid-royale. */
    if (royaleActive) return
    const count = clampCamLayout(next)
    if (count === stageLayoutCountRef.current) return
    suppressLayoutSyncRef.current = true
    setStageLayoutCount(count)
    setSlotMenuIndex(null)
    setStageSlots((prev) => {
      const nextSlots = packStageSlots(prev, count)
      stageFingerprintRef.current = stageLayoutFingerprint(count, stageFeedsToUserIds(nextSlots, me.id))
      void persistAndBroadcastStage(count, nextSlots)
      return nextSlots
    })
    window.setTimeout(() => {
      suppressLayoutSyncRef.current = false
    }, 400)
  }

  function assignStageSlot(index: number, feed: StageFeed) {
    if (!canManageStageRef.current) return
    if (feed !== null && feed !== '__local' && !roomMemberIdsRef.current.includes(feed)) return
    const count = clampCamLayout(Math.max(stageLayoutCountRef.current, index + 1))
    const camCount = count
    if (camCount !== stageLayoutCountRef.current) setStageLayoutCount(camCount)
    setStageSlots((prev) => {
      const next = [...prev]
      while (next.length < camCount) next.push(null)
      if (feed !== null) {
        for (let i = 0; i < next.length; i += 1) {
          if (i !== index && next[i] === feed) next[i] = null
        }
        /* Also clear duplicate of me as __local / id */
        if (feed === '__local' || feed === me.id) {
          for (let i = 0; i < next.length; i += 1) {
            if (i !== index && (next[i] === '__local' || next[i] === me.id)) next[i] = null
          }
        }
      }
      if (index >= 0 && index < camCount) next[index] = feed
      const trimmed = next.slice(0, camCount)
      stageFingerprintRef.current = stageLayoutFingerprint(
        camCount,
        stageFeedsToUserIds(trimmed, me.id),
      )
      void persistAndBroadcastStage(camCount, trimmed)
      return trimmed
    })
    setSlotMenuIndex(null)
    setSlotMenuPos(null)
  }

  /** Host/mod: swap anyone (including admin) between cams 1–N (big + mini). */
  function moveStageOccupant(fromIndex: number, toIndex: number) {
    if (!canManageStageRef.current) return
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || toIndex < 0) return
    const camCount = clampCamLayout(Math.max(stageLayoutCountRef.current, fromIndex + 1, toIndex + 1))
    if (camCount !== stageLayoutCountRef.current) setStageLayoutCount(camCount)
    setStageSlots((prev) => {
      const next = [...prev]
      while (next.length < camCount) next.push(null)
      if (fromIndex >= next.length || toIndex >= next.length) return prev
      const moving = next[fromIndex]
      if (moving === null) return prev
      const dest = next[toIndex]
      next[toIndex] = moving
      next[fromIndex] = dest
      const trimmed = next.slice(0, camCount)
      stageFingerprintRef.current = stageLayoutFingerprint(
        camCount,
        stageFeedsToUserIds(trimmed, me.id),
      )
      void persistAndBroadcastStage(camCount, trimmed)
      return trimmed
    })
    setSlotMenuIndex(null)
    setSlotMenuPos(null)
  }

  function slotCamLabel(slotIndex: number) {
    if (slotIndex === 0) return 'Cam 1 · big'
    if (slotIndex === 1) return 'Cam 2 · big'
    return `Cam ${slotIndex + 1} · mini`
  }

  function closeSlotMenu() {
    setSlotMenuIndex(null)
    setSlotMenuPos(null)
  }

  /** Open pop-out menu (portaled) so overflow:hidden on stage/filmstrip cannot clip it. */
  function openSlotMenu(index: number, e: React.MouseEvent | React.PointerEvent) {
    e.stopPropagation()
    e.preventDefault()
    if (slotMenuIndex === index) {
      closeSlotMenu()
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const menuW = 210
    const approxH = 280
    let left = Math.round(rect.right - menuW)
    left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8))
    let top = Math.round(rect.bottom + 6)
    if (top + approxH > window.innerHeight - 12) {
      top = Math.max(8, Math.round(rect.top - approxH - 6))
    }
    setSlotMenuPos({ top, left })
    setSlotMenuIndex(index)
  }

  useEffect(() => {
    if (slotMenuIndex === null) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeSlotMenu()
    }
    const onPointer = (ev: PointerEvent) => {
      const t = ev.target as HTMLElement | null
      if (!t) return
      if (t.closest('.stage-slot-picker--portal') || t.closest('.stage-slot-fab') || t.closest('[data-slot-menu-trigger]')) {
        return
      }
      closeSlotMenu()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [slotMenuIndex])

  function addFeedToStage(feed: string | '__local', opts?: { fromPeopleList?: boolean }) {
    if (!canManageStageRef.current) {
      console.warn('[stage] Add ignored — not host/mod')
      return
    }
    const fromPeople = opts?.fromPeopleList === true
    /* People-list Add must never use a stuck slot + menu (that silently replaces a cam). */
    if (fromPeople) setSlotMenuIndex(null)

    const knownMember =
      feed === '__local' ||
      feed === me.id ||
      roomMemberIdsRef.current.includes(feed) ||
      remoteStreamCacheRef.current.has(feed) ||
      Boolean(peerNames[feed]) ||
      fromPeople
    if (!knownMember) {
      console.warn('[stage] Add ignored — member not in room yet', feed.slice(0, 8))
      return
    }

    /* Explicit slot pick from the + menu — place exactly there (not from People Add). */
    if (!fromPeople && slotMenuIndex !== null) {
      assignStageSlot(slotMenuIndex, feed)
      return
    }

    let count = clampCamLayout(stageLayoutCountRef.current)
    const slots = [...stageSlotsRef.current]
    while (slots.length < count) slots.push(null)

    const already =
      slots.includes(feed) ||
      (feed === me.id && (slots.includes('__local') || slots.includes(me.id))) ||
      (feed === '__local' && (slots.includes('__local') || slots.includes(me.id)))
    if (already) {
      /* Already staged — still kick mesh so video fills. */
      window.setTimeout(() => {
        nudgeMeshRef.current(40)
      }, 100)
      return
    }

    const emptyIdx = slots.findIndex((s) => s === null)
    if (emptyIdx >= 0) {
      assignStageSlot(emptyIdx, feed === me.id ? '__local' : feed)
      return
    }

    /* Full — grow capacity by 1 (2→3→…→7) and keep everyone. */
    if (count < 7) {
      const nextCount = nextCamLayout(count)
      const nextSlots = [...slots]
      while (nextSlots.length < nextCount) nextSlots.push(null)
      const empty = nextSlots.findIndex((s) => s === null)
      const placed: StageFeed = feed === me.id ? '__local' : feed
      if (empty >= 0) nextSlots[empty] = placed
      else nextSlots[nextCount - 1] = placed
      suppressLayoutSyncRef.current = true
      setStageLayoutCount(nextCount)
      setStageSlots(nextSlots)
      stageFingerprintRef.current = stageLayoutFingerprint(nextCount, stageFeedsToUserIds(nextSlots, me.id))
      void persistAndBroadcastStage(nextCount, nextSlots)
      window.setTimeout(() => {
        suppressLayoutSyncRef.current = false
      }, 400)
      return
    }

    /* At 7 and full — replace last guest slot only. */
    assignStageSlot(count - 1, feed === me.id ? '__local' : feed)
  }

  addFeedToStageRef.current = addFeedToStage

  useEffect(() => {
    /* When someone lands on stage, quietly renegotiate so both cams fill. */
    if (!isLiveRoom) return
    const remoteOnStage = stageSlots.some(
      (s) => typeof s === 'string' && s !== me.id && s !== '__local',
    )
    if (!remoteOnStage && !stageSlots.includes('__local') && !stageSlots.includes(me.id)) return
    const t = window.setTimeout(() => {
      nudgeMeshRef.current(40)
    }, 350)
    return () => window.clearTimeout(t)
  }, [isLiveRoom, stageSlots, me.id])

  function invitePeerToStage(userId: string) {
    if (userId === me.id || !canManageStageRef.current) return
    setSlotMenuIndex(null)
    setPresenceOpen(false)
    addFeedToStage(userId, { fromPeopleList: true })
    setStageRequestIds((prev) => prev.filter((id) => id !== userId))
    layoutSyncRef.current?.broadcastStageRequest({ from: userId, action: 'cancel' })
    /* Kick mesh so both sides pull each other's cams into the slot immediately. */
    window.setTimeout(() => {
      nudgeMeshRef.current(40)
      void resumeRtcRef.current?.()
    }, 200)
  }

  function requestToJoinStage() {
    if (canManageStage || stageSlots.includes('__local')) return
    layoutSyncRef.current?.broadcastStageRequest({ from: me.id, action: 'request' })
    setStageRequestIds((prev) => (prev.includes(me.id) ? prev : [...prev, me.id]))
  }

  function cancelStageRequest() {
    layoutSyncRef.current?.broadcastStageRequest({ from: me.id, action: 'cancel' })
    setStageRequestIds((prev) => prev.filter((id) => id !== me.id))
  }

  function purgeRoomOverlays() {
    document.querySelectorAll('.battle-fx-portal').forEach((node) => node.remove())
  }

  async function joinOtherLive(cid: string) {
    if (!supabase || !cid || cid === conversationId || joiningLiveId) return
    setJoiningLiveId(cid)
    if (likeFlushTimerRef.current) {
      clearTimeout(likeFlushTimerRef.current)
      likeFlushTimerRef.current = null
    }
    await flushPendingLikes()
    switchingRoomRef.current = true
    await leaveOtherLiveRooms(cid, me.id)
    liveMemberRef.current = false
    membershipLeftRef.current = true
    const { error } = await supabase.rpc('join_live_room', { p_conversation_id: cid })
    setJoiningLiveId(null)
    if (error) {
      switchingRoomRef.current = false
      alert(error.message)
      return
    }
    liveMemberRef.current = true
    membershipLeftRef.current = false
    leavingRef.current = true
    layoutSyncRef.current?.detach()
    layoutSyncRef.current = null
    resumeRtcRef.current = null
    healMeshRef.current = null
    syncMeshPeersRef.current = null
    closePeerConnections(pcsRef.current)
    remoteStreamCacheRef.current.clear()
    releaseRoomMedia()
    switchingRoomRef.current = false
    nav(`/call/${cid}`, { replace: true })
  }

  async function leaveToLobby(e?: React.MouseEvent | React.PointerEvent) {
    e?.preventDefault()
    e?.stopPropagation()
    if (leavingRef.current) return
    leavingRef.current = true
    leaveAttemptAtRef.current = Date.now()
    cancelAllRoomWork()

    setSlotMenuIndex(null)
    setPortalMobileFooter(false)
    setMobileSheet('none')
    setPresenceOpen(false)
    setBattleHits([])
    suppressLayoutSyncRef.current = true

    if (conversationId && supabase && roomKindRef.current === 'live') {
      layoutSyncRef.current?.broadcastStageRequest({ from: me.id, action: 'cancel' })
    }

    layoutSyncRef.current?.detach()
    layoutSyncRef.current = null

    if (likeFlushTimerRef.current) {
      clearTimeout(likeFlushTimerRef.current)
      likeFlushTimerRef.current = null
    }
    await flushPendingLikes()

    /* Kill mesh + hardware immediately so rejoin can acquire cam/mic cleanly. */
    resumeRtcRef.current = null
    healMeshRef.current = null
    syncMeshPeersRef.current = null
    closePeerConnections(pcsRef.current)
    remoteStreamCacheRef.current.clear()
    releaseRoomMedia()

    const cid = conversationId
    const uid = me.id
    const isLiveSession = Boolean(cid && supabase && roomKindRef.current === 'live')

    if (isLiveSession && canManageStageRef.current) {
      const next = stageSlotsRef.current.map((slot) =>
        slot === '__local' || slot === uid ? null : slot,
      )
      void persistAndBroadcastStageRef.current(stageLayoutCountRef.current, next)
    }

    if (isLiveSession) {
      try {
        const ok = await leaveLiveRoomMembership(cid!, uid)
        if (ok) {
          liveMemberRef.current = false
          membershipLeftRef.current = true
        }
      } catch {
        /* best-effort membership cleanup */
      }
    }

    /* Android needs a beat after track.stop() before getUserMedia works again. */
    if (isCapacitorApp()) await sleep(450)
    nav('/home', { replace: true })
  }

  // 2-player win state derived from live battle scores (breakpoint = 25)
  const battle2pBreakpoint = 25
  const battle2pWinner = !royaleActive && battleState.enabled
    ? ((battleState.scores['alpha'] ?? 0) >= battle2pBreakpoint ? 'omega'
      : (battleState.scores['omega'] ?? 0) >= battle2pBreakpoint ? 'alpha'
      : null)
    : null
  const spotlight = pinnedPeer ?? '__local'
  // 2 large heroes + mini filmstrip for slots 3–N. Royale keeps full 7-cam board.
  const effectiveStageCount = royaleActive
    ? (7 as CamLayoutCount)
    : clampCamLayout(stageLayoutCount)
  const effectiveSlots = (() => {
    const slots = packStageSlots(stageSlots, effectiveStageCount)
    return slots
  })()
  const miniSlotCount = Math.max(0, effectiveStageCount - 2)
  const onStageFeeds = new Set(
    effectiveSlots.filter(
      (s): s is string => s !== null && s !== '__local' && roomMemberIds.includes(s),
    ),
  )
  const showNoCamBadge = !!mediaWarn && !virtualBgUrl
  const guestSlotCapacity = Math.max(0, effectiveStageCount - 1)
  const guestStageSlots = [...effectiveSlots.slice(1, effectiveStageCount)]
  while (guestStageSlots.length < guestSlotCapacity) guestStageSlots.push(null)
  const openGuestSlots = guestStageSlots.filter((s) => s === null).length
  const peopleOnStage = effectiveSlots.filter((s) => s !== null).length
  const localOnStage = effectiveSlots.includes('__local')
  const onlineMemberIds = roomMemberIds.filter((id) => id !== me.id)
  /** Flaming-heart likes always credit the room host — show badge on the host cam only. */
  const hostUserId =
    roomCreatorId ??
    (Object.entries(memberRoles).find(([, role]) => role === 'host')?.[0] ?? null) ??
    (isRoomHost ? me.id : null)
  const isHostStageFeed = (feed: StageFeed) => {
    if (!feed || !hostUserId) return false
    if (feed === '__local') return me.id === hostUserId
    return feed === hostUserId
  }
  const assignablePeers = onlineMemberIds.filter((id) => !onStageFeeds.has(id))
  const guestSlotPeerIds = new Set(
    guestStageSlots.filter((f): f is string => f !== null && f !== '__local'),
  )
  const iRequestedStage = stageRequestIds.includes(me.id)

  /** Keep local tracks aligned with mic/cam toggles — mesh always receives when enabled. */
  useEffect(() => {
    if (!isLiveRoom) return
    const s = localStreamRef.current
    if (!s) return
    const sendVideo = camOn && !ghostMode
    const sendAudio = micOn
    s.getVideoTracks().forEach((t) => {
      t.enabled = sendVideo
    })
    s.getAudioTracks().forEach((t) => {
      t.enabled = sendAudio
    })
    pcsRef.current.forEach((pc) => {
      pc.getSenders().forEach((snd) => {
        if (!snd.track) return
        if (snd.track.kind === 'video') snd.track.enabled = sendVideo
        if (snd.track.kind === 'audio') snd.track.enabled = sendAudio
      })
    })
  }, [isLiveRoom, camOn, micOn, ghostMode, localStream])

  /** Guest with mic and/or cam: request a stage slot so host can auto-add you (mic-only OK). */
  useEffect(() => {
    if (!isLiveRoom || canManageStage || localOnStage) return
    const wantsLive = micOn || (camOn && !ghostMode)
    if (!wantsLive) return
    layoutSyncRef.current?.broadcastStageRequest({ from: me.id, action: 'request' })
    setStageRequestIds((prev) => (prev.includes(me.id) ? prev : [...prev, me.id]))
  }, [isLiveRoom, canManageStage, camOn, micOn, ghostMode, localOnStage, me.id])

  const bindAllLocalPreviews = useCallback(() => {
    const s = localStreamRef.current
    if (!s) return
    for (const ref of [localRef, localMiniRef, localSelfPipRef]) {
      const el = ref.current
      if (!el) continue
      if (el.srcObject !== s) el.srcObject = s
      void el.play().catch(() => {})
    }
  }, [])

  useEffect(() => {
    bindAllLocalPreviews()
  }, [bindAllLocalPreviews, localStream, localOnStage, stageLayoutCount, virtualBgUrl, camOn, ghostMode])

  useEffect(() => {
    if (!conversationId) return
    const replayAll = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const root = roomRootRef.current
      if (root) {
        let needsReplay = false
        root.querySelectorAll('video').forEach((node) => {
          const v = node as HTMLVideoElement
          if (!v.srcObject) return
          const ms = v.srcObject as MediaStream
          const hasLiveVideo = ms.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled)
          if (v.paused || (hasLiveVideo && v.videoWidth === 0)) needsReplay = true
        })
        if (!needsReplay) return
      }
      scheduleRoomWork('media-replay', () => {
        bindAllLocalPreviews()
        replayRoomVideos(roomRootRef.current)
        replayRoomAudio(roomRootRef.current)
        void resumeSharedAudioContext()
      }, 80)
    }
    /* Stagger first replay so it doesn't stampede with mesh boot. */
    const first = window.setTimeout(replayAll, 700)
    const interval = window.setInterval(replayAll, mediaReplayIntervalMs())
    return () => {
      window.clearTimeout(first)
      window.clearInterval(interval)
    }
  }, [conversationId, remoteStreams, bindAllLocalPreviews])

  useEffect(() => {
    if (!hostMutedIds.includes(me.id)) return
    setMicOn(false)
    applyMicEnabled(false)
  }, [hostMutedIds, me.id])

  useEffect(() => {
    if (!localOnStage) return
    setStageRequestIds((prev) => {
      if (!prev.includes(me.id)) return prev
      layoutSyncRef.current?.broadcastStageRequest({ from: me.id, action: 'cancel' })
      return prev.filter((id) => id !== me.id)
    })
  }, [localOnStage, me.id])

  function liveInviteUrl() {
    if (!conversationId) return ''
    return liveRoomInviteUrl(conversationId)
  }

  const inviteUrlLocalOnly = inviteLinkIsLocalOnly(liveInviteUrl())

  async function copyInviteLink() {
    const url = liveInviteUrl()
    const fallback = conversationId
      ? `Room id (Lobby → live map): ${conversationId}`
      : ''
    const text = url || fallback
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setInviteCopied(true)
      window.setTimeout(() => setInviteCopied(false), 2200)
    } catch {
      window.prompt('Copy this invite info:', text)
    }
  }

  async function shareInviteLink() {
    const url = liveInviteUrl()
    const title = titles.room?.trim() || 'Orion Live'
    const body = inviteUrlLocalOnly
      ? `${title} — open Orion Social → Lobby → tap "${title}" on the live map. Room id: ${conversationId}`
      : `Join ${title} on Orion Social (live video, up to ${LIVE_ROOM_MAX_CAMS} cams): ${url}`
    try {
      if (navigator.share) {
        await navigator.share({
          title,
          text: body,
          url: url || undefined,
        })
        return
      }
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return
    }
    await copyInviteLink()
  }

  useEffect(() => {
    const s = localStreamRef.current
    if (!s) return
    s.getAudioTracks().forEach((t) => {
      t.enabled = !!micOnRef.current
    })
    const [vt] = s.getVideoTracks()
    if (!vt) {
      if (!camOn || ghostMode) return
      if (!hasRealCameraRef.current && virtualBgRef.current) applyVirtualBackground(virtualBgRef.current)
      return
    }
    if (ghostMode || !camOn) {
      vt.enabled = false
      if (!hasRealCameraRef.current && virtualBgRef.current) applyVirtualBackground(virtualBgRef.current)
      return
    }
    vt.enabled = true
  }, [camOn, ghostMode, applyVirtualBackground])

  useEffect(() => {
    const mini = localMiniRef.current
    const s = localStreamRef.current
    if (!mini) return
    if (isNativeShell()) return
    if (!localOnStage && s) {
      mini.srcObject = s
      void mini.play().catch(() => {})
    } else {
      mini.srcObject = null
    }
  }, [localOnStage, camOn, ghostMode, localStream])

  function handleBattleEvent(message: string) {
    chatEventSeqRef.current += 1
    const id = `battle:${Date.now()}:${chatEventSeqRef.current}`
    setBattleChatExtras((msgs) => [
      ...msgs,
      {
        id,
        senderName: 'Battle Mode',
        body: message,
        createdAt: new Date().toISOString(),
      },
    ])
  }

  const registerBattleStopReset = useCallback((fn: (() => void) | null) => {
    battleStopResetRef.current = fn
  }, [])

  function handleBattleHit(hit: BattleCameraHit) {
    battleHitSeqRef.current += 1
    const activeHit = { ...hit, id: `${hit.id}:render:${battleHitSeqRef.current}` }
    setBattleHits((hits) => [...hits.slice(-2), activeHit])
    const durationMs = hit.videoSrc ? 4500 : 2800
    window.setTimeout(() => {
      setBattleHits((hits) => hits.filter((current) => current.id !== activeHit.id))
    }, durationMs)
  }

  const handleBattleLiveState = useCallback(
    (next: {
      scores: Record<string, number>
      royaleScores: Record<string, number>
      enabled: boolean
      royaleMode: boolean
      wallet: number
      target: string
      royaleTarget: string
      selectedGiftId: string
    }) => {
      setBattleState((prev) => {
        const sameScores =
          prev.scores.alpha === next.scores.alpha && prev.scores.omega === next.scores.omega
        const sameRoyale = BATTLE_TEAM_BY_SLOT.every(
          (t) => (prev.royaleScores[t] ?? 0) === (next.royaleScores[t] ?? 0),
        )
        if (
          sameScores &&
          sameRoyale &&
          prev.enabled === next.enabled &&
          prev.royaleMode === next.royaleMode &&
          prev.wallet === next.wallet &&
          prev.target === next.target &&
          prev.royaleTarget === next.royaleTarget &&
          prev.selectedGiftId === next.selectedGiftId
        ) {
          return prev
        }
        return {
          scores: { ...next.scores },
          royaleScores: { ...next.royaleScores },
          enabled: next.enabled,
          royaleMode: next.royaleMode,
          wallet: next.wallet,
          target: next.target,
          royaleTarget: next.royaleTarget,
          selectedGiftId: next.selectedGiftId,
        }
      })
    },
    [],
  )

  function handleRoyaleElimination(team: string) {
    setRoyaleEliminated((prev) => (prev.includes(team) ? prev : [...prev, team]))
  }

  function handleRoyaleWinner(team: string) {
    setRoyaleWinnerTeam(team)
  }

  function clearBattleOverlays() {
    setRoyaleEliminated([])
    setRoyaleWinnerTeam(null)
    setBattleHits([])
  }

  function stopAndResetBattleFromStage() {
    clearBattleOverlays()
    setRoyaleActive(false)
    broadcastRoomLayout({ royale: false, camCount: stageLayoutCountRef.current })
    battleStopResetRef.current?.()
  }

  function startClip(opts?: { maxSeconds?: number }) {
    const stream = localStreamRef.current
    if (!stream || clipping) return
    /* Prefer real camera; virtual-BG canvas stream still records. */
    const liveTracks = stream.getTracks().filter((t) => t.readyState === 'live')
    if (!liveTracks.length) {
      alert('Turn on your camera or mic to record live.')
      return
    }
    const maxSec = Math.min(120, Math.max(10, opts?.maxSeconds ?? (canManageStageRef.current ? 60 : 30)))
    clipMaxRef.current = maxSec
    setClipMaxSeconds(maxSec)
    clipChunksRef.current = []
    clipBlobRef.current = null
    setClipReady(false)
    setReelPosted(false)
    setClipSeconds(0)

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : MediaRecorder.isTypeSupported('video/webm')
          ? 'video/webm'
          : MediaRecorder.isTypeSupported('video/mp4')
            ? 'video/mp4'
            : ''
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
    } catch {
      alert('Recording is not supported on this device.')
      return
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) clipChunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(clipChunksRef.current, { type: mimeType || 'video/webm' })
      clipBlobRef.current = blob
      setClipReady(blob.size > 0)
      setClipping(false)
      if (clipTimerRef.current) clearInterval(clipTimerRef.current)
    }

    recorder.start(250)
    clipRecorderRef.current = recorder
    setClipping(true)

    clipTimerRef.current = setInterval(() => {
      setClipSeconds((s) => {
        const limit = clipMaxRef.current
        if (s >= limit - 1) {
          if (recorder.state !== 'inactive') recorder.stop()
          return limit
        }
        return s + 1
      })
    }, 1000)
  }

  function stopClip() {
    if (clipRecorderRef.current?.state !== 'inactive') clipRecorderRef.current?.stop()
    if (clipTimerRef.current) clearInterval(clipTimerRef.current)
  }

  function saveClip() {
    const blob = clipBlobRef.current
    if (!blob) return
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `orion-live-${Date.now()}.${ext}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  async function addClipToReel() {
    const blob = clipBlobRef.current
    if (!blob || !supabase || publishingReel) return
    setPublishingReel(true)
    try {
      await publishLiveClipAsReel({
        userId: me.id,
        blob,
        roomTitle: titles.room,
        durationSeconds: clipSeconds || clipMaxSeconds,
      })
      setReelPosted(true)
      alert('Posted to Orion Reels · open Reels / Profile to watch it.')
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not add clip to Reels')
    } finally {
      setPublishingReel(false)
    }
  }

  // ── Camera score overlay ──────────────────────────────────────────────────
  const BP = 25
  function releaseRoomMedia() {
    detachRoomMediaElements(roomRootRef.current)
    detachRoomMediaElements(document.body)
    void restoreRoomAudio()
    if (mediaReleasedRef.current) return
    mediaReleasedRef.current = true
    try {
      closePeerConnections(pcsRef.current)
      remoteStreamCacheRef.current.clear()
      stopBgFeed()
      purgeRoomOverlays()
      discardMediaStream(localStreamRef.current)
      localStreamRef.current = null
      setLocalStream(null)
      setRemoteStreams({})
    } catch {
      /* best-effort cleanup */
    }
  }

  function openThread() {
    if (isLiveRoom) {
      setStudioRailTab('chat')
      setBattlePanelOpen(false)
      setMobileSheet('none')
      if (portalMobileFooter && isCapacitorApp()) {
        window.setTimeout(() => {
          document.querySelector('.studio-sidebar .studio-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }, 0)
      }
      return
    }
    nav(`/chat/${conversationId ?? ''}${peerHint ? `?peer=${peerHint}` : ''}`)
  }

  function openMobileSettings(e?: React.SyntheticEvent) {
    /* Desktop/EXE: park Host Controls below the + button (~2" clear of the top chrome). */
    if (!isCapacitorApp()) {
      const btn =
        (e?.currentTarget instanceof HTMLElement ? e.currentTarget : null) ??
        (document.querySelector('.live-toolbar-plus-fab') as HTMLElement | null)
      const toolbar = document.querySelector('.live-toolbar--studio') as HTMLElement | null
      const btnRect = btn?.getBoundingClientRect()
      const barRect = toolbar?.getBoundingClientRect()
      const minTop = Math.round((barRect?.bottom ?? btnRect?.bottom ?? 120) + 16)
      /* ~2 inches below the previous cramped top (~192px), never under the toolbar. */
      const top = Math.min(Math.max(minTop, 300), Math.max(80, window.innerHeight - 140))
      const right = btnRect
        ? Math.max(12, Math.round(window.innerWidth - btnRect.right))
        : 12
      setPlusMenuPos({ top, right })
    } else {
      setPlusMenuPos(null)
    }
    setMobileSheet('settings')
    setSlotMenuIndex(null)
  }

  function openMobileBattle() {
    setStudioRailTab('battle')
    setBattlePanelOpen(true)
    setMobileSheet('battle')
  }

  function closeMobileSheet(e?: React.SyntheticEvent) {
    e?.preventDefault()
    e?.stopPropagation()
    setMobileSheet('none')
    setPlusMenuPos(null)
  }

  function openBackgroundPicker() {
    setSlotMenuIndex(null)
    if (!openFilePicker(bgFileInputRef.current)) {
      setMediaWarn('Could not open image picker — tap Background in the toolbar or allow file access in Brave Shields.')
      setMediaWarnDismissed(false)
    }
  }

  function clearVirtualBgAndCloseMenu() {
    clearVirtualBg()
    setSlotMenuIndex(null)
    setSlotMenuPos(null)
  }

  function kickLiveMember(userId: string) {
    if (!conversationId || !supabase || !isRoomHost) return
    if (!window.confirm(`Remove ${peerLabel(userId)} from this room?`)) return
    void supabase
      .rpc('kick_live_member', {
        p_conversation_id: conversationId,
        p_user_id: userId,
      })
      .then(({ error }) => {
        if (error) setErr(error.message)
        else void loadRoomRoles({ hydrateStage: false })
      })
    setSlotMenuIndex(null)
  }

  function banLiveMember(userId: string) {
    if (!conversationId || !supabase || !isRoomHost) return
    if (!window.confirm(`Ban ${peerLabel(userId)} from this room? They cannot rejoin.`)) return
    void supabase
      .rpc('ban_live_member', {
        p_conversation_id: conversationId,
        p_user_id: userId,
      })
      .then(({ error }) => {
        if (error) setErr(error.message)
        else void loadRoomRoles({ hydrateStage: false })
      })
    setSlotMenuIndex(null)
  }

  /** Host/mod forces a member's mic off for the whole room (not a local volume hack). */
  function setHostMuteUser(userId: string, muted: boolean) {
    if (!canManageStageRef.current || userId === me.id) return
    const next = new Set(hostMutedIdsRef.current)
    if (muted) next.add(userId)
    else next.delete(userId)
    const list = [...next]
    applyHostMutedIds(list)
    layoutSyncRef.current?.broadcastHostMute({
      from: me.id,
      targetUserId: userId,
      muted,
      mutedUserIds: list,
    })
    layoutSyncRef.current?.broadcast({
      from: me.id,
      camCount: stageLayoutCountRef.current,
      stageSlots: stageFeedsToUserIds(stageSlotsRef.current, me.id),
      mutedUserIds: list,
    })
    setSlotMenuIndex(null)
  }

  function LivePresenceList() {
    const rosterIds = [...new Set([me.id, ...roomMemberIds])]

    const presenceOf = (uid: string): 'stage' | 'watching' | 'lurking' => {
      if (uid === me.id) {
        if (effectiveSlots.includes('__local')) return 'stage'
        if (localStream && (micOn || camOn)) return 'watching'
        return 'lurking'
      }
      if (onStageFeeds.has(uid)) return 'stage'
      if (remoteStreams[uid] || remoteOrder.includes(uid)) return 'watching'
      return 'lurking'
    }

    return (
      <ul className="live-presence-list">
        {rosterIds.map((uid) => {
          const presence = presenceOf(uid)
          const role = memberRoles[uid] ?? (uid === roomCreatorId ? 'host' : 'member')
          const badge = roleBadge(role)
          const wantsStage = stageRequestIds.includes(uid)
          const onStage =
            uid === me.id
              ? effectiveSlots.includes('__local')
              : onStageFeeds.has(uid) && roomMemberIds.includes(uid)
          const hostCanInvite = canManageStageRef.current && uid !== me.id && !onStage
          return (
            <li key={uid} className={`live-presence-row live-presence-row--${presence}`}>
              <button
                type="button"
                className={`live-presence-name${hostCanInvite ? ' live-presence-name--action' : ''}`}
                title={uid === me.id ? 'You' : peerLabel(uid)}
                disabled={!hostCanInvite}
                onClick={() => hostCanInvite && invitePeerToStage(uid)}
              >
                <ProfileAvatar
                  src={peerAvatarUrl(uid)}
                  name={uid === me.id ? me.display_name || 'You' : peerLabel(uid)}
                  size="sm"
                />
                <span className="live-presence-name-text">{uid === me.id ? 'You' : peerLabel(uid)}</span>
                {badge && <span className="live-presence-role">{badge}</span>}
              </button>
              <span
                className={`live-presence-badge live-presence-badge--${wantsStage && !onStage ? 'request' : presence}`}
              >
                {wantsStage && !onStage ? 'WANTS CAM' : presence === 'stage' ? 'ON CAM' : presence === 'watching' ? 'WATCH' : 'ROOM'}
              </span>
              {canManageStageRef.current && uid !== me.id && (
                <span className="live-presence-actions">
                  {hostCanInvite && (
                    <button
                      type="button"
                      className="secondary live-host-stage-up"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        invitePeerToStage(uid)
                      }}
                    >
                      {wantsStage ? 'Accept' : 'Add'}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`secondary${hostMutedIds.includes(uid) ? ' live-host-mute--on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setHostMuteUser(uid, !hostMutedIds.includes(uid))
                    }}
                  >
                    {hostMutedIds.includes(uid) ? 'Unmute' : 'Mute'}
                  </button>
                  <button
                    type="button"
                    className="secondary live-host-kick"
                    onClick={(e) => {
                      e.stopPropagation()
                      kickLiveMember(uid)
                    }}
                  >
                    Kick
                  </button>
                  <button
                    type="button"
                    className="secondary live-host-ban"
                    onClick={(e) => {
                      e.stopPropagation()
                      banLiveMember(uid)
                    }}
                  >
                    Ban
                  </button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
    )
  }

  function LiveRoomPresencePanel() {
    const rosterIds = [...new Set([me.id, ...roomMemberIds])]
    const stageCount = rosterIds.filter((id) => {
      if (id === me.id) return effectiveSlots.includes('__local')
      return onStageFeeds.has(id)
    }).length
    const watchingCount = rosterIds.length - stageCount

    return (
      <section className="live-presence-panel live-presence-panel--inline font-mono" aria-label="Who is in the room">
        <button
          type="button"
          className="live-presence-toggle"
          onClick={() => setPresenceOpen((o) => !o)}
          aria-expanded={presenceOpen}
        >
          <span className="live-presence-title">In room · {rosterIds.length}</span>
          <span className="live-presence-stats">
            {stageCount} stage · {watchingCount} watching
          </span>
          <span className="live-presence-chevron">{presenceOpen ? '▾' : '▸'}</span>
        </button>
        {presenceOpen && <LivePresenceList />}
      </section>
    )
  }

  function LivePresenceFab({ inline = false }: { inline?: boolean }) {
    const rosterIds = [...new Set([me.id, ...roomMemberIds])]
    const count = rosterIds.length
    return (
      <>
        <button
          type="button"
          className={`live-presence-fab${inline ? ' live-presence-fab--inline' : ''}${presenceOpen ? ' live-presence-fab--open' : ''}`}
          aria-label={`${count} people in room`}
          aria-expanded={presenceOpen}
          onClick={() => setPresenceOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <path
              fill="currentColor"
              d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"
            />
          </svg>
          <span className="live-presence-fab-count">{count}</span>
          {inline && <span className="live-presence-fab-label">IN ROOM</span>}
          {isRoomHost && stageRequestIds.some((id) => id !== me.id) && (
            <span className="live-presence-fab-alert" aria-label="Stage requests pending">
              •
            </span>
          )}
        </button>
        {presenceOpen && (
          <>
            <button type="button" className="live-presence-scrim" aria-label="Close people list" onClick={() => setPresenceOpen(false)} />
            <section className="live-presence-sheet font-mono" aria-label="Who is in the room">
              <header className="live-presence-sheet-head">
                <span>In room · {rosterIds.length}</span>
                <button type="button" className="live-presence-sheet-close" onClick={() => setPresenceOpen(false)}>
                  ✕
                </button>
              </header>
              <LivePresenceList />
            </section>
          </>
        )}
      </>
    )
  }

  function InviteBar() {
    const url = liveInviteUrl()
    return (
      <div className="room-invite-bar font-mono" role="region" aria-label="Invite guests">
        <div className="room-invite-bar-head">
          <div className="room-invite-bar-meta">
            <span className="room-invite-bar-title">{titles.room?.trim() || 'Live room'}</span>
            <span className="room-invite-bar-stats">
              {peopleOnStage}/{effectiveStageCount} cams · {openGuestSlots} open guest {openGuestSlots === 1 ? 'slot' : 'slots'}
            </span>
          </div>
          <div className="room-invite-bar-actions">
            <button type="button" className="secondary room-invite-btn" onClick={() => void copyInviteLink()}>
              {inviteCopied ? 'Copied!' : 'Copy link'}
            </button>
            <button type="button" className="primary room-invite-btn" onClick={() => void shareInviteLink()}>
              Share invite
            </button>
          </div>
        </div>
        <label className="room-invite-url-field">
          <span className="room-invite-url-label">{inviteUrlLocalOnly ? 'Room id (Lobby join)' : 'Invite URL'}</span>
          <input
            className="room-invite-url-input"
            readOnly
            value={inviteUrlLocalOnly ? (conversationId ?? '') : url}
            onFocus={(e) => e.target.select()}
            onClick={() => void copyInviteLink()}
            aria-label="Live room invite link or id"
          />
        </label>
        <p className="room-invite-hint">
          {inviteUrlLocalOnly ? (
            <>
              <strong className="room-invite-warn">Link is localhost — phones cannot open it.</strong> Guests: open{' '}
              <strong>Lobby</strong> → tap this room on the live map. Or set{' '}
              <code>VITE_PUBLIC_APP_URL</code> in <code>web/.env</code> to your hosted web URL and rebuild.
            </>
          ) : (
            <>Send the link — guests sign in, tap Join, and fill an open guest slot. Or they join from Lobby → live map.</>
          )}
        </p>
      </div>
    )
  }

  function HostModPanel() {
    if (!isRoomHost || !conversationId) return null
    const roster = [me.id, ...roomMemberIds.filter((id) => id !== me.id)]
    return (
      <div className={`live-host-panel font-mono${hostPanelOpen ? ' live-host-panel--open' : ''}`}>
        <button
          type="button"
          className="live-host-panel-toggle secondary"
          aria-expanded={hostPanelOpen}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setHostPanelOpen((open) => !open)
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="live-host-panel-chevron" aria-hidden>
            {hostPanelOpen ? '▾' : '▸'}
          </span>
          Host controls
          <span className="live-host-panel-toggle-hint">{hostPanelOpen ? 'close' : 'open'}</span>
        </button>
        {hostPanelOpen && (
        <div className="live-host-panel-body">
            <label className="live-host-toggle">
              <input
                type="checkbox"
                checked={modsEnabled}
                onChange={(e) => {
                  const on = e.target.checked
                  setModsEnabled(on)
                  void supabase
                    ?.rpc('set_live_mods_enabled', { p_conversation_id: conversationId, p_enabled: on })
                    .then(({ error }) => {
                      if (error) setErr(error.message)
                      else void loadRoomRoles({ hydrateStage: false })
                    })
                }}
              />
              <span>Allow moderators to manage stage layout</span>
            </label>
            <p className="live-host-panel-hint">
              Use <strong>Add</strong> to put someone on cam. First two stay large; extras are mini under them. Open{' '}
              <strong>+</strong> and pick 2–7 for stage capacity.
            </p>
            <ul className="live-host-roster">
              {roster.map((uid) => {
                const role = memberRoles[uid] ?? (uid === roomCreatorId ? 'host' : 'member')
                const badge = roleBadge(role)
                const onStage =
                  uid === me.id ? effectiveSlots.includes('__local') : onStageFeeds.has(uid)
                const canAddGuest = uid !== me.id && !onStage
                const isForcedMute = hostMutedIds.includes(uid)
                return (
                  <li key={uid} className="live-host-roster-row">
                    <span className="live-host-roster-name">
                      <ProfileAvatar
                        src={peerAvatarUrl(uid)}
                        name={uid === me.id ? me.display_name || 'You' : peerLabel(uid)}
                        size="sm"
                      />
                      <span className="live-host-roster-name-text">{uid === me.id ? 'You' : peerLabel(uid)}</span>
                      {badge && <span className="live-host-role-badge">{badge}</span>}
                      {onStage && uid !== me.id && <span className="live-host-role-badge live-host-role-badge--on">ON CAM</span>}
                      {isForcedMute && <span className="live-host-role-badge live-host-role-badge--mute">MUTED</span>}
                    </span>
                    {uid !== me.id && (
                      <span className="live-host-roster-actions">
                        {canAddGuest && (
                          <button
                            type="button"
                            className="secondary live-host-stage-up"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              invitePeerToStage(uid)
                            }}
                          >
                            Add
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setHostMuteUser(uid, !isForcedMute)}
                        >
                          {isForcedMute ? 'Unmute' : 'Mute'}
                        </button>
                        {role === 'member' && modsEnabled && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              void supabase
                                ?.rpc('promote_live_moderator', {
                                  p_conversation_id: conversationId,
                                  p_user_id: uid,
                                })
                                .then(({ error }) => {
                                  if (error) setErr(error.message)
                                  else void loadRoomRoles({ hydrateStage: false })
                                })
                            }
                          >
                            Make mod
                          </button>
                        )}
                        {role === 'moderator' && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              void supabase
                                ?.rpc('demote_live_moderator', {
                                  p_conversation_id: conversationId,
                                  p_user_id: uid,
                                })
                                .then(({ error }) => {
                                  if (error) setErr(error.message)
                                  else void loadRoomRoles({ hydrateStage: false })
                                })
                            }
                          >
                            Demote
                          </button>
                        )}
                        {role !== 'host' && (
                          <>
                            <button
                              type="button"
                              className="secondary live-host-kick"
                              onClick={() => kickLiveMember(uid)}
                            >
                              Kick
                            </button>
                            <button
                              type="button"
                              className="secondary live-host-ban"
                              onClick={() => banLiveMember(uid)}
                            >
                              Ban
                            </button>
                          </>
                        )}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            <button
              type="button"
              className="secondary live-host-panel-close"
              onClick={() => setHostPanelOpen(false)}
            >
              Close host controls
            </button>
        </div>
        )}
      </div>
    )
  }

  function CamScoreBar({ team, royale = false }: { team: string; royale?: boolean }) {
    const score = royale ? (battleState.royaleScores[team] ?? 0) : (battleState.scores[team] ?? 0)
    const pct = Math.min(100, (score / BP) * 100)
    const isTarget = royale ? battleState.royaleTarget === team : battleState.target === team
    if (!battleState.enabled && !royale) return null
    return (
      <div className={`cam-score-bar${isTarget ? ' cam-score-bar--target' : ''}`}>
        <div className="cam-score-fill" style={{ width: `${pct}%` }} />
        <span className="cam-score-label">{score}/{BP}</span>
      </div>
    )
  }

  function MobileRoomFooterNav({ portaled = false }: { portaled?: boolean }) {
    const openPeopleTab = () => {
      setStudioRailTab('people')
      setBattlePanelOpen(false)
      setMobileSheet('none')
    }
    const openChatTab = () => {
      setStudioRailTab('chat')
      setBattlePanelOpen(false)
      setMobileSheet('none')
    }
    const openBattleTab = () => {
      setStudioRailTab('battle')
      setBattlePanelOpen(true)
      setMobileSheet('none')
    }

    return (
      <nav
        className={`mobile-room-footer${portaled ? ' mobile-room-footer--portaled' : ''}${isCapacitorApp() ? ' mobile-room-footer--apk' : ' mobile-room-footer--exe'} font-mono`}
        aria-label="Live room actions"
      >
        <button
          className="mobile-room-action"
          type="button"
          onClick={leaveToLobby}
          onPointerDown={(ev) => ev.stopPropagation()}
          aria-label="Open lobby"
        >
          <RoomIcon name="home" />
          <span>Lobby</span>
        </button>
        <button
          className={`mobile-room-action ${!micOn || hostMutedIds.includes(me.id) ? 'mobile-room-action--hot' : ''}`}
          type="button"
          onClick={toggleMic}
          disabled={hostMutedIds.includes(me.id)}
          aria-label={
            hostMutedIds.includes(me.id)
              ? 'Muted by host'
              : micOn
                ? 'Mute microphone'
                : 'Unmute microphone'
          }
        >
          <RoomIcon name={micOn && !hostMutedIds.includes(me.id) ? 'mic' : 'micOff'} />
          <span>{hostMutedIds.includes(me.id) ? 'Host muted' : micOn ? 'Mic' : 'Muted'}</span>
        </button>
        <button
          className={`mobile-room-action ${!camOn ? 'mobile-room-action--hot' : ''}`}
          type="button"
          onClick={() => setCamOn((x) => !x)}
          aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
        >
          <RoomIcon name={camOn ? 'camera' : 'cameraOff'} />
          <span>{camOn ? 'Cam' : 'Off'}</span>
        </button>
        {!isCapacitorApp() && isLiveRoom && (
          <>
            <button
              className={`mobile-room-action${studioRailTab === 'chat' ? ' mobile-room-action--hot' : ''}`}
              type="button"
              onClick={openChatTab}
              aria-label="Open chat"
            >
              <RoomIcon name="chat" />
              <span>Chat</span>
            </button>
            <button
              className={`mobile-room-action${studioRailTab === 'people' ? ' mobile-room-action--hot' : ''}`}
              type="button"
              onClick={openPeopleTab}
              aria-label="Open people list"
            >
              <RoomIcon name="people" />
              <span>People</span>
            </button>
            <button
              className={`mobile-room-action${studioRailTab === 'battle' ? ' mobile-room-action--hot' : ''}`}
              type="button"
              onClick={openBattleTab}
              aria-label="Open battle mode"
            >
              <RoomIcon name="battle" />
              <span>Battle</span>
            </button>
          </>
        )}
        {isLiveRoom && (
          <div className="mobile-room-footer-inroom">
            <LivePresenceFab inline />
          </div>
        )}
        {isCapacitorApp() && isLiveRoom && !canManageStage && !localOnStage && (
          <button
            className={`mobile-room-action${iRequestedStage ? ' mobile-room-action--hot' : ''}`}
            type="button"
            onClick={() => (iRequestedStage ? cancelStageRequest() : requestToJoinStage())}
            aria-label={iRequestedStage ? 'Cancel stage request' : 'Request to join stage'}
          >
            <RoomIcon name="layout" />
            <span>{iRequestedStage ? 'Pending' : 'Stage'}</span>
          </button>
        )}
        {isCapacitorApp() && (
          <button className="mobile-room-action" type="button" onClick={() => void flipCamera()} aria-label="Flip camera">
            <RoomIcon name="swap" />
            <span>Flip</span>
          </button>
        )}
      </nav>
    )
  }

  const slimLiveToolbar = isLiveRoom
  /* Bottom sheet is APK-only. EXE/Chrome must use the desktop + menu (with a working ✕). */
  const livePlusSheet = isCapacitorApp()
  /* EXE uses sticky top Mute/Camera/Invite — never show the broken grey tab-bar footer. */
  const showMobileRoomFooter = isLiveRoom && isCapacitorApp()
  const showInRoomInStudioTabs = false
  const showInRoomInToolbar = isLiveRoom && !isCapacitorApp()

  function LiveRoomPlusMenuBody({ popover = false }: { popover?: boolean }) {
    const itemClass = (hot = false) =>
      popover ? (hot ? 'primary' : 'secondary') : `mobile-settings-item${hot ? ' mobile-settings-item--hot' : ''}`

    return (
      <>
        {micDevices.length > 1 && (
          <label className={`room-device-field room-device-field--mic live-plus-menu-mic${popover ? ' live-plus-menu-mic--popover' : ''}`}>
            <span className="room-device-label font-mono">Mic</span>
            <select
              className="room-device-select font-mono"
              value={selectedMicId}
              onChange={(e) => void switchMic(e.target.value)}
              aria-label="Microphone device"
            >
              <option value="">Default mic</option>
              {micDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${device.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className={itemClass(Boolean(virtualBgUrl || showNoCamBadge))}
          onClick={() => {
            openBackgroundPicker()
            closeMobileSheet()
          }}
        >
          {!popover && <RoomIcon name="bg" />}
          <span>Background</span>
        </button>
        {virtualBgUrl && (
          <button
            type="button"
            className={itemClass()}
            onClick={() => {
              clearVirtualBg()
              closeMobileSheet()
            }}
          >
            {!popover && <RoomIcon name="bg" />}
            <span>Clear background</span>
          </button>
        )}
        <button type="button" className={itemClass(ghostMode)} onClick={() => setGhostMode((x) => !x)}>
          {!popover && <RoomIcon name="ghost" />}
          <span>{ghostMode ? 'Ghost mode on' : 'Ghost mode'}</span>
        </button>
        <button
          type="button"
          className={itemClass(clipping)}
          onClick={() => {
            if (clipping) stopClip()
            else startClip({ maxSeconds: canManageStage ? 60 : 30 })
          }}
        >
          {!popover && <RoomIcon name="layout" />}
          <span>
            {clipping
              ? `Stop ${clipMaxSeconds - clipSeconds}s`
              : canManageStage
                ? 'Record Live (60s)'
                : 'Record 30s clip'}
          </span>
        </button>
        {clipReady && (
          <>
            <button
              type="button"
              className={itemClass(true)}
              disabled={publishingReel}
              onClick={() => void addClipToReel()}
            >
              {!popover && <RoomIcon name="invite" />}
              <span>
                {publishingReel ? 'Posting reel…' : reelPosted ? 'Posted to Reels ✓' : 'Add to Reel'}
              </span>
            </button>
            <button type="button" className={itemClass()} onClick={saveClip}>
              {!popover && <RoomIcon name="invite" />}
              <span>Save file (later)</span>
            </button>
          </>
        )}
        <button type="button" className={itemClass(inviteCopied)} onClick={() => void shareInviteLink()}>
          {!popover && <RoomIcon name="invite" />}
          <span>{inviteCopied ? 'Invite copied' : 'Invite link'}</span>
        </button>
        <button
          type="button"
          className={itemClass()}
          onClick={() => {
            closeMobileSheet()
            openMobileBattle()
          }}
        >
          {!popover && <RoomIcon name="battle" />}
          <span>Battle mode</span>
        </button>
        {isLiveRoom && !canManageStage && !localOnStage && (
          <button
            type="button"
            className={itemClass(iRequestedStage)}
            onClick={() => {
              if (iRequestedStage) cancelStageRequest()
              else requestToJoinStage()
              closeMobileSheet()
            }}
          >
            {!popover && <RoomIcon name="layout" />}
            <span>{iRequestedStage ? 'Cancel stage request' : 'Request stage (mic or cam)'}</span>
          </button>
        )}
        {isLiveRoom && canManageStage && !royaleActive && (
          <div className={popover ? 'live-plus-menu-layout' : 'mobile-settings-layout'}>
            <span className={popover ? 'live-toolbar-panel-label font-mono' : 'mobile-settings-layout-label'}>
              Stage capacity · first 2 large
            </span>
            <div className={popover ? 'live-toolbar-layout-pills' : 'mobile-settings-layout-pills'}>
              {CAM_LAYOUT_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`cam-layout-pill${effectiveStageCount === n ? ' cam-layout-pill--active' : ''}`}
                  aria-pressed={effectiveStageCount === n}
                  disabled={royaleActive}
                  title={
                    royaleActive
                      ? 'Locked at 7 during Battle Royale'
                      : n <= 2
                        ? '2 large cams only'
                        : `${n} cams · 2 large + ${n - 2} mini`
                  }
                  onClick={() => {
                    setCamLayoutCount(n)
                    closeMobileSheet()
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}
      </>
    )
  }

  function MobileSettingsSheet() {
    if (mobileSheet !== 'settings' || !livePlusSheet) return null
    return createPortal(
      <>
        <button
          type="button"
          className="mobile-sheet-scrim"
          aria-label="Close menu"
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            closeMobileSheet(e)
          }}
          onClick={(e) => closeMobileSheet(e)}
        />
        <div className="mobile-settings-sheet font-mono" role="dialog" aria-label="Room options">
          <div className="mobile-settings-head">
            <span>Room options</span>
            <button
              type="button"
              className="mobile-settings-close"
              aria-label="Close"
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                closeMobileSheet(e)
              }}
              onClick={(e) => closeMobileSheet(e)}
            >
              ✕
            </button>
          </div>
          <div className="mobile-settings-body">
            <LiveRoomPlusMenuBody />
          </div>
        </div>
      </>,
      document.body,
    )
  }

  function DesktopPlusMenuPopover() {
    if (mobileSheet !== 'settings' || livePlusSheet) return null
    return createPortal(
      <>
        <button
          type="button"
          className="mobile-sheet-scrim"
          aria-label="Close menu"
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            closeMobileSheet(e)
          }}
          onClick={(e) => closeMobileSheet(e)}
        />
        <div
          className="live-toolbar-plus-menu live-toolbar-plus-menu--portal stage-slot-picker font-mono"
          role="dialog"
          aria-label="Room options"
          style={
            plusMenuPos
              ? {
                  top: plusMenuPos.top,
                  right: plusMenuPos.right,
                  left: 'auto',
                  maxHeight: `min(58vh, calc(100vh - ${plusMenuPos.top + 24}px))`,
                }
              : undefined
          }
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="live-plus-menu-head">
            <span className="live-plus-menu-title">Host controls</span>
            <button
              type="button"
              className="mobile-settings-close live-plus-menu-close"
              aria-label="Close"
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                closeMobileSheet(e)
              }}
              onClick={(e) => closeMobileSheet(e)}
            >
              ✕
            </button>
          </div>
          <LiveRoomPlusMenuBody popover />
        </div>
      </>,
      document.body,
    )
  }

  const rosterCount = [...new Set([me.id, ...roomMemberIds])].length

  return (
    <div
      ref={roomRootRef}
      className={`live-room matrix-live live-room--studio${isLiveRoom ? ' live-room--live-footer' : ''}${isCapacitorApp() ? ' live-room--native' : ''}${localOnStage ? ' live-room--local-on-stage' : ''}${canManageStage ? ' live-room--stage-host' : ''}`}
    >
      <input
        ref={bgFileInputRef}
        id="orion-virtual-bg-file"
        type="file"
        accept="image/*"
        className="visually-hidden-file-input"
        onChange={onVirtualBgPick}
      />
      <div
        className={`live-toolbar live-toolbar--studio matrix-toolbar font-mono${slimLiveToolbar ? ' live-toolbar--slim' : ''}`}
      >
        <div className="live-toolbar-row live-toolbar-row--top">
          <div className="live-toolbar-nav">
            <button
              className="matrix-link-back studio-nav-btn"
              type="button"
              onClick={leaveToLobby}
              onPointerDown={(ev) => ev.stopPropagation()}
            >
              ← Lobby
            </button>
            {isLiveRoom && isRoomHost && (
              <span className="live-host-badge font-mono" title="You control stage layout and mods">
                HOST
              </span>
            )}
            {isLiveRoom && myRoomRole === 'moderator' && modsEnabled && (
              <span className="live-mod-badge font-mono" title="Moderator — stage controls enabled">
                MOD
              </span>
            )}
            {isLiveRoom && (
              <button
                className={`matrix-link-back studio-nav-btn studio-nav-btn--thread${studioRailTab === 'chat' ? ' studio-nav-btn--active' : ''}`}
                type="button"
                onClick={openThread}
              >
                Thread
              </button>
            )}
            {!isLiveRoom && (
              <Link
                className="matrix-link-back studio-nav-btn studio-nav-btn--soft"
                to={`/chat/${conversationId ?? ''}${peerHint ? `?peer=${peerHint}` : ''}`}
              >
                DM chat
              </Link>
            )}
          </div>

          <div className="live-toolbar-meta">
            {isLiveRoom && <span className="live-badge-live">Live</span>}
            {showInRoomInToolbar && <LivePresenceFab inline />}
            <span className="matrix-session-id" title={titles.room?.trim() || conversationId}>
              {titles.kind === 'live' ? '' : 'Call · '}
              {titles.room?.trim() || conversationId?.slice(0, 8)}
            </span>
            {slimLiveToolbar && (
              <div className="live-toolbar-plus-wrap">
                <button
                  type="button"
                  className={`stage-slot-fab live-toolbar-plus-fab font-mono${mobileSheet === 'settings' ? ' live-toolbar-plus-fab--open' : ''}`}
                  onClick={(e) => (mobileSheet === 'settings' ? closeMobileSheet(e) : openMobileSettings(e))}
                  aria-label="Room options"
                  aria-expanded={mobileSheet === 'settings'}
                >
                  +
                </button>
              </div>
            )}
          </div>
        </div>

        {isLiveRoom && !isCapacitorApp() && (
          <div className="live-toolbar-row live-toolbar-row--controls live-toolbar-row--live-exe">
            <div className="live-toolbar-controls">
              <button
                className={micOn && !hostMutedIds.includes(me.id) ? 'secondary' : 'primary'}
                type="button"
                onClick={toggleMic}
                disabled={hostMutedIds.includes(me.id)}
              >
                {hostMutedIds.includes(me.id) ? 'Host muted' : micOn ? 'Mute' : 'Unmute'}
              </button>
              <button className={camOn ? 'secondary' : 'primary'} type="button" onClick={() => setCamOn((x) => !x)}>
                {camOn ? 'Camera off' : 'Camera on'}
              </button>
              <button className="secondary" type="button" onClick={() => void shareInviteLink()}>
                {inviteCopied ? 'Copied!' : 'Invite'}
              </button>
              {/* Host / stage admin: Record Live on EXE top bar → Add to Reel */}
              {canManageStage && (
                <>
                  <button
                    className={clipping ? 'primary' : 'secondary'}
                    type="button"
                    onClick={() => (clipping ? stopClip() : startClip({ maxSeconds: 60 }))}
                    title="Record up to 60s from your live cam for Reels"
                  >
                    {clipping ? `● Rec ${clipMaxSeconds - clipSeconds}s` : 'Record Live'}
                  </button>
                  {clipReady && (
                    <>
                      <button
                        className="primary"
                        type="button"
                        disabled={publishingReel || reelPosted}
                        onClick={() => void addClipToReel()}
                        title="Upload clip and publish to Orion Reels"
                      >
                        {publishingReel ? 'Posting…' : reelPosted ? 'On Reels ✓' : 'Add to Reel'}
                      </button>
                      <button className="secondary" type="button" onClick={saveClip} title="Download clip to post later">
                        Save file
                      </button>
                    </>
                  )}
                </>
              )}
              {!canManageStage && !localOnStage && (
                <button
                  className={iRequestedStage ? 'primary' : 'secondary'}
                  type="button"
                  onClick={() => (iRequestedStage ? cancelStageRequest() : requestToJoinStage())}
                  title="Ask the host to put you on stage"
                >
                  {iRequestedStage ? 'Cancel request' : 'Request stage'}
                </button>
              )}
            </div>
          </div>
        )}

        {!isLiveRoom && (
        <div className="live-toolbar-row live-toolbar-row--controls">
        <div className="live-toolbar-controls">
          <button className={micOn ? 'secondary' : 'primary'} type="button" onClick={toggleMic}>
            {micOn ? 'Mute' : 'Unmute'}
          </button>
          <label className="room-device-field room-device-field--mic">
            <span className="room-device-label font-mono">Mic</span>
            <select
              className="room-device-select font-mono"
              value={selectedMicId}
              onChange={(e) => void switchMic(e.target.value)}
              aria-label="Microphone device"
            >
              <option value="">Default mic</option>
              {micDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${device.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <button className={camOn ? 'secondary' : 'primary'} type="button" onClick={() => setCamOn((x) => !x)}>
            {camOn ? 'Camera off' : 'Camera on'}
          </button>
          <label
            className="secondary room-bg-file-label"
            htmlFor="orion-virtual-bg-file"
            title="Use an image when camera is unavailable"
          >
            Background
          </label>
          {virtualBgUrl && (
            <button className="secondary" type="button" onClick={clearVirtualBg} title="Remove background image">
              Clear bg
            </button>
          )}
          <button
            className={ghostMode ? 'primary' : 'secondary'}
            type="button"
            onClick={() => setGhostMode((x) => !x)}
            title="Stop sending video (others see black)"
          >
            Ghost
          </button>
          <button className="secondary" type="button" onClick={() => void flipCamera()}>
            Flip
          </button>
          {isLiveRoom && !canManageStage && !localOnStage && (
            <button
              className={iRequestedStage ? 'primary' : 'secondary'}
              type="button"
              onClick={() => (iRequestedStage ? cancelStageRequest() : requestToJoinStage())}
              title="Ask the host to put you on stage"
            >
              {iRequestedStage ? 'Cancel request' : 'Request cam'}
            </button>
          )}
        </div>

        <div className="live-toolbar-actions">
          {isLiveRoom && canManageStage && (
            <label className="room-device-field room-device-field--layout">
              <span className="room-device-label font-mono">Layout</span>
              <select
                className="room-device-select font-mono"
                value={effectiveStageCount}
                disabled={royaleActive}
                onChange={(e) => setCamLayoutCount(Number(e.target.value))}
                aria-label="Stage camera layout"
              >
                {[2, 3, 4, 5, 6, 7].map((n) => (
                  <option key={n} value={n}>
                    {n} cams
                  </option>
                ))}
              </select>
            </label>
          )}
          {isLiveRoom && (
            <button className="secondary" type="button" onClick={() => void shareInviteLink()} title="Share live room invite link">
              Invite
            </button>
          )}
          {isLiveRoom && (
            <button
              className={studioRailTab === 'battle' ? 'primary' : 'secondary'}
              type="button"
              onClick={() => {
                setStudioRailTab('battle')
                setBattlePanelOpen(true)
              }}
            >
              Battle
            </button>
          )}
          <button
            className={clipping ? 'primary' : 'secondary'}
            type="button"
            onClick={() => (clipping ? stopClip() : startClip({ maxSeconds: 30 }))}
            title="Record a 30-second clip from your camera"
          >
            {clipping ? `Stop ${clipMaxSeconds - clipSeconds}s` : 'Clip'}
          </button>
          {clipReady && (
            <>
              <button
                className="primary"
                type="button"
                disabled={publishingReel || reelPosted}
                onClick={() => void addClipToReel()}
                title="Upload and publish to Orion Reels"
              >
                {publishingReel ? 'Posting…' : reelPosted ? 'On Reels ✓' : 'Add to Reel'}
              </button>
              <button className="secondary" type="button" onClick={saveClip} title="Download your clip">
                Save file
              </button>
            </>
          )}
        </div>
        </div>
        )}
      </div>

      {!isLiveRoom && (
        <p className="matrix-hint font-mono">
          MAX <span className="matrix-hint-accent">7</span> VIDEO NODES · MESH · PIN SPOTLIGHT · PROD: TURN/SFU
        </p>
      )}

      {err ? (
        <div className="matrix-alert matrix-alert--err font-mono" role="alert">
          <span className="matrix-alert-tag">ERR</span>
          {err}
        </div>
      ) : (
        <>
          {isCapacitorApp() && mediaWarn && !mediaWarnDismissed && (
            <div className="cam-warn-toast font-mono" role="alert">
              <svg className="cam-warn-toast-icon" viewBox="0 0 24 24" aria-hidden>
                <line x1="2" y1="2" x2="22" y2="22"/>
                <path d="M10.66 6H14a2 2 0 0 1 2 2v3.34l1.06 1.06A2 2 0 0 0 20 10.5V7a1 1 0 0 1 1.54-.84l.92.55"/>
                <path d="M19.07 17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1.07"/>
              </svg>
              <span className="cam-warn-toast-msg">{mediaWarn}</span>
              <button className="cam-warn-toast-retry" type="button" onClick={() => { void retryRealtimeAndMedia() }}>Retry</button>
              <button className="cam-warn-toast-close" type="button" aria-label="Dismiss" onClick={() => setMediaWarnDismissed(true)}>✕</button>
            </div>
          )}
          {isLiveRoom && !isCapacitorApp() && isBraveBrowser() && !braveHintDismissed && (
            <div className="cam-warn-toast cam-warn-toast--brave font-mono" role="note">
              <span className="cam-warn-toast-msg">
                <strong>Brave — cams black?</strong> (1) Tap the <strong>lion</strong> left of the address bar →{' '}
                <strong>Shields</strong> → set to <strong>Down</strong> for this site. (2) Click the lock icon →{' '}
                <strong>Site settings</strong> → allow <strong>Camera</strong> and <strong>Microphone</strong>. (3){' '}
                Shields also block <strong>gift animations</strong> (WebGL) — same fix. (4){' '}
                <strong>Ctrl+Shift+R</strong> hard refresh, rejoin the live room, then tap <strong>Retry cams</strong>.
              </span>
              <button className="cam-warn-toast-retry" type="button" onClick={() => { void retryRealtimeAndMedia(); replayRoomVideos(roomRootRef.current) }}>
                Retry cams
              </button>
              <button className="cam-warn-toast-close" type="button" aria-label="Dismiss" onClick={() => setBraveHintDismissed(true)}>✕</button>
            </div>
          )}
          <p className="matrix-status-line font-mono">
            <span className="matrix-status-label">STATUS</span> <code className="matrix-code-inline">{status}</code>
          </p>
        </>
      )}

      {isLiveRoom && conversationId && !err ? (
        <div
          className="tiktok-live-root studio-live"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button,a,input,select,textarea,label') === null) {
              setLikes((n) => n + 1)
              broadcastRoomLike(1)
              setSlotMenuIndex(null)
              if (mobileSheet === 'settings') closeMobileSheet()
              replayRoomVideos(roomRootRef.current)
              replayRoomAudio(roomRootRef.current)
              resumeSharedAudioContext()
            }
          }}
        >
          <div className="room-audio-mix" aria-hidden>
            {remoteOrder.map((pid) => {
              const stream = remoteStreams[pid]
              if (!stream) return null
              return (
                <RemotePeerAudio
                  key={`peer-audio-${pid}`}
                  peerId={pid}
                  stream={stream}
                  silenced={hostMutedIds.includes(pid)}
                />
              )
            })}
          </div>
          <section className={`tiktok-live-main studio-layout${studioRailTab === 'chat' ? ' studio-layout--chat-open' : ''}${studioRailTab === 'battle' ? ' studio-layout--battle-open' : ''}${studioRailTab === 'people' ? ' studio-layout--people-open' : ''}${royaleActive ? ' studio-layout--royale' : ''}`}>
            <div className="studio-stage-column">
            {isRoomHost && <HostModPanel />}
            {isRoomHost &&
              (royaleActive ||
              battleState.enabled ||
              royaleEliminated.length > 0 ||
              !!royaleWinnerTeam ||
              !!battle2pWinner) && (
              <div className="battle-stage-reset-bar font-mono">
                <button
                  type="button"
                  className="primary battle-stage-reset-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    stopAndResetBattleFromStage()
                  }}
                >
                  STOP · RESET BATTLE
                </button>
                <span className="battle-stage-reset-hint">Clears Eliminated / Winner overlays now</span>
              </div>
            )}
            {isCapacitorApp() && (showNoCamBadge || mediaWarn) && (
              <button type="button" className="mobile-bg-cta font-mono" onClick={openBackgroundPicker}>
                No camera · Tap to set a background image
              </button>
            )}
            {isLiveRoom && !isCapacitorApp() && !canManageStage && !localOnStage && (
              <p className="live-viewer-hint font-mono" role="status">
                Watching as guest — host cam fills the main slots when connected. Turn on mic/cam and use{' '}
                <strong>Request stage</strong> in the bar above, or open <strong>+</strong> for more options.
                {iRequestedStage ? ' · Request sent — waiting for host' : ''}
              </p>
            )}
            {isLiveRoom && isCapacitorApp() && (
              <div className="studio-stage-rails" aria-label="Winners and other lives">
                <div className="studio-winners-rail font-mono" aria-label="Battle League winners">
                  <span className="studio-rail-label">WINNERS</span>
                  <div className="studio-rail-scroll">
                    {leagueTop.length === 0 ? (
                      <span className="studio-rail-empty">No league wins yet — finish a battle</span>
                    ) : (
                      leagueTop.slice(0, 5).map((row, i) => (
                        <span key={row.userId} className="studio-winner-pill">
                          <em>#{i + 1}</em> {row.displayName}
                          <b>
                            {row.wins}W · {row.points}pts
                          </b>
                        </span>
                      ))
                    )}
                  </div>
                </div>
                <div className="studio-lives-rail font-mono" aria-label="Other live rooms">
                  <span className="studio-rail-label">LIVES</span>
                  <div className="studio-rail-scroll">
                    {otherLives.length === 0 ? (
                      <span className="studio-rail-empty">No other lives listed</span>
                    ) : (
                      otherLives.map((room) => (
                        <button
                          key={room.id}
                          type="button"
                          className="studio-live-pill"
                          disabled={joiningLiveId === room.id}
                          onClick={() => void joinOtherLive(room.id)}
                        >
                          <span className="studio-live-pill-title">{room.title}</span>
                          <span className="studio-live-pill-count">{room.members}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
            <div
              className={`tiktok-stage-shell tiktok-stage-shell--battle${
                royaleActive ? ' tiktok-stage-shell--royale-live' : ''
              }`}
            >
              {effectiveSlots.slice(0, 2).map((feed, index) => {
                const team = BATTLE_TEAM_BY_SLOT[index]
                const battleBorderOn = (royaleActive || battleState.enabled) && Boolean(team)
                const teamColor = team ? ROYALE_COLORS[team] : undefined
                const isLocal = feed === '__local' || feed === me.id
                const stream = feed && !isLocal ? remoteStreams[feed] ?? null : null
                const label = isLocal
                  ? me.display_name?.trim() || 'You'
                  : feed
                    ? peerLabel(feed)
                    : index === 0
                      ? 'HOST SLOT'
                      : `GUEST SLOT ${index}`
                return (
                  <div
                    key={`stage-${index}-${feed ?? 'empty'}`}
                    ref={(el) => {
                      if (el) stageRefsMap.current.set(index, el)
                      else stageRefsMap.current.delete(index)
                    }}
                    className={`tiktok-stage battle-host-stage stage-slot${isLocal ? ' stage-slot--local' : ''}${feed === null ? ' stage-slot--empty' : ''}${slotMenuIndex === index ? ' stage-slot--picker' : ''}${team && royaleEliminated.includes(team) ? ' royale-eliminated' : ''}${team && royaleWinnerTeam === team ? ' royale-winner' : ''}${isLocal && virtualBgUrl ? ' stage-has-virtual-bg' : ''}${battleBorderOn ? ` stage-slot--battle-team stage-slot--team-${team}` : ''}`}
                    data-battle-team={battleBorderOn ? team : undefined}
                    style={
                      battleBorderOn && teamColor
                        ? ({ ['--battle-team-color' as string]: teamColor } as React.CSSProperties)
                        : undefined
                    }
                  >
                    <span className="tiktok-stage-badge font-mono">
                      {(royaleActive || battleState.enabled) && team ? `${team.toUpperCase()} · ` : ''}
                      {label}
                      {!isLocal && typeof feed === 'string' && hostMutedIds.includes(feed) ? ' · MUTED' : ''}
                      {isLocal && hostMutedIds.includes(me.id) ? ' · MUTED' : ''}
                    </span>
                    {(royaleActive || battleState.enabled) && team && (
                      <span
                        className="battle-team-chip font-mono"
                        style={{ ['--battle-team-color' as string]: ROYALE_COLORS[team] }}
                      >
                        {team.toUpperCase()}
                      </span>
                    )}
                    {royaleActive && team && <span className="battle-host-break font-mono">TARGET HOST</span>}
                    {(() => {
                      const showVideo = shouldMountStageVideo(isLocal, stream, localStream, camOn, ghostMode)
                      const localVideoOk = isLocal && showVideo
                      const remoteVideoOk = !isLocal && showVideo
                      const occupantId = isLocal ? me.id : typeof feed === 'string' ? feed : null
                      const occupantName = isLocal ? me.display_name || 'You' : feed ? peerLabel(feed) : label
                      if (localVideoOk) {
                        return (
                          <LocalStageVideo
                            videoRef={localRef}
                            stream={localStream}
                            mirror={isCapacitorApp() && !facingBack && !virtualBgUrl}
                            className={`tiktok-stage-video tiktok-stage-video--local ${ghostMode ? 'dim' : ''}`}
                          />
                        )
                      }
                      if (remoteVideoOk && stream) {
                        return (
                          <RemoteVideo
                            key={`hero-vid-${index}-${feed}-${videoEpoch}`}
                            stream={stream}
                            className="tiktok-stage-video"
                            remountEpoch={videoEpoch}
                          />
                        )
                      }
                      if (occupantId) {
                        return (
                          <div className="tiktok-stage-wait font-mono stage-slot-wait">
                            <SlotProfileFallback src={peerAvatarUrl(occupantId)} name={occupantName} />
                          </div>
                        )
                      }
                      if (feed === null) {
                        return canManageStage ? (
                          <button
                            type="button"
                            className="tiktok-stage-wait font-mono stage-slot-add stage-slot-invite stage-slot-orion-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              void shareInviteLink()
                            }}
                          >
                            <OrionSlotLogo label="Invite · open slot" />
                          </button>
                        ) : (
                          <div className="tiktok-stage-wait font-mono stage-slot-add stage-slot-wait">
                            <OrionSlotLogo label={index === 0 ? 'Host cam' : 'Open slot'} />
                          </div>
                        )
                      }
                      if (!isLocal && !roomMemberIds.includes(feed)) {
                        return (
                          <div className="tiktok-stage-wait font-mono stage-slot-add stage-slot-invite">
                            <OrionSlotLogo label="Guest left" />
                          </div>
                        )
                      }
                      return (
                        <div className="tiktok-stage-wait font-mono stage-slot-wait">
                          <OrionSlotLogo label="Connecting…" />
                        </div>
                      )
                    })()}
                    {(isLocal || stream) &&
                      (isCapacitorApp() && !isLocal ? (
                        <span className="studio-thumb-mic-badge font-mono tiktok-stage-mic-badge" aria-hidden>
                          {typeof feed === 'string' && hostMutedIds.includes(feed) ? 'MUTE' : 'MIC'}
                        </span>
                      ) : (
                        <CamVolumeMeter
                          stream={isLocal ? localStream : stream}
                          active={
                            isLocal
                              ? micOn && !ghostMode && !hostMutedIds.includes(me.id)
                              : typeof feed === 'string' && !hostMutedIds.includes(feed)
                          }
                          compact={isCapacitorApp()}
                        />
                      ))}
                    {isCapacitorApp() && isLocal && showNoCamBadge && (
                      <div className="cam-no-signal" title={mediaWarnDismissed ? mediaWarn ?? undefined : undefined}>
                        <svg viewBox="0 0 24 24" aria-label="No camera signal">
                          <line x1="2" y1="2" x2="22" y2="22" />
                          <path d="M10.66 6H14a2 2 0 0 1 2 2v3.34l1.06 1.06A2 2 0 0 0 20 10.5V7a1 1 0 0 1 1.54-.84l.92.55" />
                          <path d="M19.07 17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1.07" />
                        </svg>
                        <span>NO CAM</span>
                      </div>
                    )}
                    {isHostStageFeed(feed) && likes > 0 && (
                      <div className="like-power-badge" title="Room likes for the host">
                        <span>❤️‍🔥</span>
                        <span>{likes.toLocaleString()}</span>
                        {likeLeaguePoints > 0 && <span className="like-lp">· {likeLeaguePoints} LP</span>}
                      </div>
                    )}
                    {team && royaleEliminated.includes(team) && (
                      <div className="royale-elim-overlay">
                        <div className="royale-elim-flash" />
                        <div className="royale-elim-x">
                          <div className="royale-elim-bar royale-elim-bar--a" />
                          <div className="royale-elim-bar royale-elim-bar--b" />
                        </div>
                        <div className="royale-elim-label font-mono">Eliminated</div>
                      </div>
                    )}
                    {team && royaleWinnerTeam === team && (
                      <div className="royale-win-overlay">
                        <span>👑 WINNER</span>
                      </div>
                    )}
                    {!royaleActive && team === 'alpha' && battle2pWinner === 'alpha' && (
                      <div className="battle2p-win-overlay">
                        <span>👑 WINNER</span>
                      </div>
                    )}
                    {!royaleActive && team === 'omega' && battle2pWinner === 'omega' && (
                      <div className="battle2p-win-overlay">
                        <span>👑 WINNER</span>
                      </div>
                    )}
                    {!royaleActive && team === 'alpha' && battle2pWinner === 'omega' && (
                      <div className="royale-elim-overlay">
                        <div className="royale-elim-flash" />
                        <div className="royale-elim-x">
                          <div className="royale-elim-bar royale-elim-bar--a" />
                          <div className="royale-elim-bar royale-elim-bar--b" />
                        </div>
                        <div className="royale-elim-label font-mono">Defeated</div>
                      </div>
                    )}
                    {!royaleActive && team === 'omega' && battle2pWinner === 'alpha' && (
                      <div className="royale-elim-overlay">
                        <div className="royale-elim-flash" />
                        <div className="royale-elim-x">
                          <div className="royale-elim-bar royale-elim-bar--a" />
                          <div className="royale-elim-bar royale-elim-bar--b" />
                        </div>
                        <div className="royale-elim-label font-mono">Defeated</div>
                      </div>
                    )}
                    {team && (royaleActive || index < 2) && (
                      <CamScoreBar team={team} royale={royaleActive} />
                    )}
                    {(canManageStage || isLocal) && (
                      <>
                        {isLocal && (
                          <button
                            type="button"
                            className={`stage-slot-bg-btn font-mono${virtualBgUrl ? ' stage-slot-bg-btn--live' : ''}`}
                            aria-label={virtualBgUrl ? 'Return to live camera' : 'Set background image'}
                            title={virtualBgUrl ? 'Back to camera' : 'Use image as cam'}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (virtualBgUrl) clearVirtualBg()
                              else openBackgroundPicker()
                            }}
                          >
                            {virtualBgUrl ? 'CAM' : 'BG'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="stage-slot-fab font-mono"
                          data-slot-menu-trigger
                          aria-label={
                            canManageStage
                              ? isLocal
                                ? 'Stage slot options'
                                : feed === null
                                  ? 'Invite guest to this slot'
                                  : 'Guest slot options'
                              : 'Your camera options'
                          }
                          aria-expanded={slotMenuIndex === index}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => openSlotMenu(index, e)}
                        >
                          +
                        </button>
                      </>
                    )}
                  </div>
                )
              })}
            </div>

            {miniSlotCount > 0 && (
            <div
              className="tiktok-filmstrip studio-filmstrip studio-filmstrip--guest-rail"
              aria-label={`Extra live cams 3 to ${effectiveStageCount}`}
              data-mini-count={miniSlotCount}
            >
                {Array.from({ length: miniSlotCount }, (_, stripIdx) => {
                  const index = stripIdx + 2
                  const feed = (effectiveSlots[index] ?? null) as StageFeed
                  const team = BATTLE_TEAM_BY_SLOT[index] as RoyaleSlotTeam | undefined
                  const battleBorderOn =
                    Boolean(team) && (royaleActive || (battleState.enabled && index < 2))
                  const teamColor = team && battleBorderOn ? ROYALE_COLORS[team] : undefined
                  const isLocal = feed === '__local' || feed === me.id
                  const stream = feed && !isLocal ? remoteStreams[feed] ?? null : null
                  const label = isLocal
                    ? me.display_name?.trim() || 'You'
                    : feed
                      ? peerLabel(feed)
                      : `Slot ${index + 1}`
                  const showVideo = shouldMountStageVideo(isLocal, stream, localStream, camOn, ghostMode)
                  const localVideoOk = isLocal && showVideo
                  const remoteVideoOk = !isLocal && showVideo
                  const hasLiveVideo = localVideoOk || remoteVideoOk
                  const occupantId = isLocal ? me.id : typeof feed === 'string' ? feed : null
                  return (
                    <div
                      key={`strip-${index}-${feed ?? 'empty'}`}
                      ref={(el) => {
                        if (el) stageRefsMap.current.set(index, el)
                        else stageRefsMap.current.delete(index)
                      }}
                      className={`studio-thumb-card live-tile tiktok-mini stage-slot-icon${isLocal ? ' stage-slot--local' : ''}${feed === null ? ' stage-slot--empty' : ''}${slotMenuIndex === index ? ' stage-slot--picker' : ''}${team && royaleEliminated.includes(team) ? ' royale-eliminated' : ''}${team && royaleWinnerTeam === team ? ' royale-winner' : ''}${battleBorderOn ? ` stage-slot--battle-team stage-slot--team-${team}` : ''}`}
                      data-battle-team={battleBorderOn ? team : undefined}
                      data-slot-menu-trigger={canManageStage ? true : undefined}
                      style={
                        battleBorderOn && teamColor
                          ? ({ ['--battle-team-color' as string]: teamColor } as React.CSSProperties)
                          : undefined
                      }
                      onClick={(e) => {
                        if (!canManageStage) return
                        if ((e.target as HTMLElement).closest('.stage-slot-fab')) return
                        openSlotMenu(index, e)
                      }}
                    >
                      <div className="studio-thumb-media">
                        {localVideoOk && localStream ? (
                          <RemoteVideo
                            key={`strip-local-${index}-${videoEpoch}`}
                            stream={localStream}
                            className={`tiktok-stage-video ${ghostMode ? 'dim' : ''}`}
                            remountEpoch={videoEpoch}
                          />
                        ) : remoteVideoOk && stream ? (
                          <RemoteVideo
                            key={`strip-vid-${index}-${feed}-${videoEpoch}`}
                            stream={stream}
                            className="tiktok-stage-video"
                            remountEpoch={videoEpoch}
                          />
                        ) : occupantId ? (
                          <div className="studio-thumb-wait studio-thumb-media--invite studio-thumb-profile-btn">
                            <SlotProfileFallback
                              compact
                              src={peerAvatarUrl(occupantId)}
                              name={label}
                            />
                          </div>
                        ) : (
                          <div className="studio-thumb-wait studio-thumb-media--invite studio-thumb-orion-btn">
                            <OrionSlotLogo compact label="+" />
                          </div>
                        )}
                        {occupantId && !hasLiveVideo && (
                          <span className="studio-thumb-mic-badge font-mono" aria-hidden>
                            {isLocal && (!micOn || hostMutedIds.includes(me.id))
                              ? 'MUTE'
                              : typeof feed === 'string' && hostMutedIds.includes(feed)
                                ? 'MUTE'
                                : 'MIC'}
                          </span>
                        )}
                        {/* Mini cams: skip Web Audio meters on APK — heroes keep them. */}
                        {!isCapacitorApp() && (isLocal || stream) && (
                          <CamVolumeMeter
                            stream={isLocal ? localStream : stream}
                            active={
                              isLocal
                                ? micOn && !ghostMode && !hostMutedIds.includes(me.id)
                                : typeof feed === 'string' && !hostMutedIds.includes(feed)
                            }
                            compact
                          />
                        )}
                        {isHostStageFeed(feed) && likes > 0 && (
                          <div className="like-power-badge like-power-badge--mini" title="Room likes for the host">
                            <span>❤️‍🔥</span>
                            <span>{likes.toLocaleString()}</span>
                          </div>
                        )}
                        {battleBorderOn && team && (
                          <span
                            className="studio-thumb-royale-tag font-mono"
                            style={{ ['--battle-team-color' as string]: ROYALE_COLORS[team] }}
                          >
                            {team.toUpperCase()}
                          </span>
                        )}
                        {team && royaleEliminated.includes(team) && (
                          <div className="royale-elim-overlay royale-elim-overlay--mini">
                            <div className="royale-elim-label font-mono">OUT</div>
                          </div>
                        )}
                        {team && royaleWinnerTeam === team && (
                          <div className="royale-win-overlay royale-win-overlay--mini">
                            <span>👑</span>
                          </div>
                        )}
                        {team && royaleActive && <CamScoreBar team={team} royale />}
                        {(canManageStage || isLocal) && (
                          <button
                            type="button"
                            className="stage-slot-fab stage-slot-fab--icon font-mono"
                            data-slot-menu-trigger
                            aria-label={
                              canManageStage
                                ? `Cam slot ${index + 1} options`
                                : 'Add background'
                            }
                            aria-expanded={slotMenuIndex === index}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              if (canManageStage) {
                                openSlotMenu(index, e)
                                return
                              }
                              if (isLocal) openBackgroundPicker()
                            }}
                          >
                            +
                          </button>
                        )}
                      </div>
                      <span className="studio-thumb-label font-mono">
                        {royaleActive && team ? `${team.toUpperCase()} · ` : ''}
                        {hasLiveVideo || occupantId ? label : `Slot ${index + 1}`}
                        {!isLocal && typeof feed === 'string' && hostMutedIds.includes(feed) ? ' · M' : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            {battleHits.map((hit) => (
              <CameraBattleEffect
                key={hit.id}
                hit={hit}
                slotIndex={ROYALE_TEAM_SLOT[hit.target as RoyaleSlotTeam] ?? 0}
                stageRefsMap={stageRefsMap}
              />
            ))}

            {!royaleActive &&
              isCapacitorApp() &&
              !localOnStage &&
              !canManageStage &&
              roomCreatorId !== me.id &&
              myRoomRole !== 'host' && (
              <div className="live-local-offstage font-mono" aria-label="Your camera preview">
                <div className="live-local-offstage-card">
                  <div className="live-local-offstage-media">
                    {camOn && !ghostMode && localStream ? (
                      <LocalStageVideo
                        videoRef={localMiniRef}
                        stream={localStream}
                        className="tiktok-stage-video"
                      />
                    ) : (
                      <div className="studio-thumb-wait studio-thumb-orion-btn">
                        <OrionSlotLogo compact label="Cam off" />
                      </div>
                    )}
                    <button
                      type="button"
                      className={`stage-slot-bg-btn font-mono${virtualBgUrl ? ' stage-slot-bg-btn--live' : ''}`}
                      aria-label={virtualBgUrl ? 'Return to live camera' : 'Set background image'}
                      title={virtualBgUrl ? 'Back to camera' : 'Use image as cam'}
                      onClick={() => {
                        if (virtualBgUrl) clearVirtualBg()
                        else openBackgroundPicker()
                      }}
                    >
                      {virtualBgUrl ? 'CAM' : 'BG'}
                    </button>
                    <button
                      type="button"
                      className="stage-slot-fab font-mono"
                      aria-label="Your camera options"
                      onClick={() => setSlotMenuIndex((p) => (p === -1 ? null : -1))}
                    >
                      +
                    </button>
                    {slotMenuIndex === -1 && (
                      <div className="stage-slot-picker font-mono" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="secondary" onClick={openBackgroundPicker}>
                          Background
                        </button>
                        {virtualBgUrl && (
                          <button type="button" className="secondary" onClick={clearVirtualBgAndCloseMenu}>
                            Clear bg
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <span className="live-local-offstage-label">You · not on stage — tap BG or +</span>
                </div>
              </div>
            )}

            {/* All cams live on the main stage grid — no duplicate filmstrip (broke 3+ layouts). */}

            </div>

            <aside
              className={`studio-sidebar${
                portalMobileFooter && isCapacitorApp()
                  ? studioRailTab === 'battle' || mobileSheet === 'battle'
                    ? ' studio-sidebar--battle-open studio-sidebar--mobile-sheet'
                    : studioRailTab === 'people'
                      ? ' studio-sidebar--people-open studio-sidebar--mobile-sheet'
                      : studioRailTab === 'chat'
                        ? ' studio-sidebar--chat-open studio-sidebar--mobile-sheet'
                        : ''
                  : `${studioRailTab === 'chat' ? ' studio-sidebar--chat-open' : ''}${studioRailTab === 'battle' ? ' studio-sidebar--battle-open' : ''}${studioRailTab === 'people' ? ' studio-sidebar--people-open' : ''}`
              }`}
              aria-label="Live room sidebar"
            >
              {isLiveRoom && (
              <div className="studio-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={studioRailTab === 'chat'}
                  className={`studio-tab${studioRailTab === 'chat' ? ' studio-tab--active' : ''}`}
                  onClick={() => {
                    setStudioRailTab('chat')
                    setBattlePanelOpen(false)
                    setMobileSheet('none')
                  }}
                >
                  Chat
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={studioRailTab === 'people'}
                  className={`studio-tab${studioRailTab === 'people' ? ' studio-tab--active' : ''}`}
                  onClick={() => {
                    setStudioRailTab('people')
                    setBattlePanelOpen(false)
                    setMobileSheet('none')
                  }}
                >
                  People
                  <span className="studio-tab-badge">{rosterCount}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={studioRailTab === 'battle'}
                  className={`studio-tab${studioRailTab === 'battle' ? ' studio-tab--active' : ''}`}
                  onClick={() => {
                    setStudioRailTab('battle')
                    setBattlePanelOpen(true)
                    setMobileSheet('none')
                  }}
                >
                  Battle
                  {(battleState.enabled || royaleActive) && (
                    <span className="studio-tab-badge">{battleState.wallet}c</span>
                  )}
                </button>
                {showInRoomInStudioTabs && (
                  <div className="studio-tabs-inroom">
                    <LivePresenceFab inline />
                  </div>
                )}
              </div>
              )}

              <div className="studio-panels" data-active-tab={studioRailTab}>
                {isLiveRoom && studioRailTab === 'chat' && (
                <div
                  className="studio-panel studio-panel--chat studio-panel--visible"
                  role="tabpanel"
                >
                  <div className="royale-chat-wrap studio-chat-wrap">
                    <LiveChatPanel
                      conversationId={conversationId}
                      me={me}
                      roomTitle={titles.room ?? ''}
                      extraMessages={battleChatExtras}
                      mode="panel"
                      showRailHeader
                      onLeaveToLobby={() => void leaveToLobby()}
                    />
                  </div>
                </div>
                )}

                {isLiveRoom && studioRailTab === 'people' && (
                <div
                  className="studio-panel studio-panel--people studio-panel--visible"
                  role="tabpanel"
                  aria-label="People in room"
                >
                  <div className="studio-people-panel font-mono">
                    <header className="studio-people-head">
                      <span>In room · {rosterCount}</span>
                      {isRoomHost && stageRequestIds.some((id) => id !== me.id) && (
                        <span className="studio-people-alert">Add requests pending</span>
                      )}
                    </header>
                    <LivePresenceList />
                  </div>
                </div>
                )}

                {/* Single battle instance: visible only on Battle tab; off-screen otherwise so it cannot leak under Chat/People. */}
                {isLiveRoom && conversationId && (
                <div
                  className={
                    studioRailTab === 'battle'
                      ? 'studio-panel studio-panel--battle studio-panel--visible'
                      : 'studio-battle-engine-hidden'
                  }
                  role={studioRailTab === 'battle' ? 'tabpanel' : undefined}
                  aria-hidden={studioRailTab !== 'battle'}
                >
                  <div className="studio-battle-scroll">
                    <BattleModePanel
                      variant="studio"
                      conversationId={conversationId}
                      canRecordLeague={canManageStage}
                      canControl={isRoomHost}
                      onBattleEvent={handleBattleEvent}
                      onBattleHit={handleBattleHit}
                      onLeagueUpdate={setLeagueTop}
                      onRoyaleModeChange={(active) => {
                        setRoyaleActive(active)
                        if (!active) {
                          setRoyaleEliminated([])
                          setRoyaleWinnerTeam(null)
                        }
                        // Do not change camCount — START BATTLE / ROYALE must keep cams on screen.
                        broadcastRoomLayout({ royale: active, camCount: stageLayoutCountRef.current })
                      }}
                      onRoyaleElimination={handleRoyaleElimination}
                      onRoyaleWinner={handleRoyaleWinner}
                      onRoyaleReset={clearBattleOverlays}
                      onRegisterStopReset={registerBattleStopReset}
                      onLiveState={handleBattleLiveState}
                    />
                  </div>
                  {studioRailTab === 'battle' && (
                  <button
                    type="button"
                    className="studio-battle-close secondary"
                    onClick={() => {
                      setBattlePanelOpen(false)
                      setStudioRailTab('chat')
                      if (portalMobileFooter && isCapacitorApp()) closeMobileSheet()
                    }}
                  >
                    Close battle
                  </button>
                  )}
                </div>
                )}
              </div>
            </aside>

          </section>
          {slimLiveToolbar && mobileSheet === 'battle' && (
            <button type="button" className="mobile-sheet-scrim" aria-label="Close panel" onClick={closeMobileSheet} />
          )}
          {slimLiveToolbar && <MobileSettingsSheet />}
          {slimLiveToolbar && <DesktopPlusMenuPopover />}
          {canManageStage &&
            slotMenuIndex !== null &&
            slotMenuIndex >= 0 &&
            slotMenuPos &&
            createPortal(
              <div
                className="stage-slot-picker stage-slot-picker--portal font-mono"
                style={{ top: slotMenuPos.top, left: slotMenuPos.left }}
                role="menu"
                aria-label={`Cam ${slotMenuIndex + 1} options`}
                onClick={(e) => e.stopPropagation()}
              >
                {(() => {
                  const index = slotMenuIndex
                  const feed = (effectiveSlots[index] ?? null) as StageFeed
                  const isLocal = feed === '__local' || feed === me.id
                  const placeablePeers = onlineMemberIds.filter((id) => {
                    if (feed === id) return false
                    if (isLocal && id === me.id) return false
                    return true
                  })
                  const selfAlreadyHere = isLocal
                  return (
                    <>
                      <span className="stage-slot-picker-heading">
                        {slotCamLabel(index)}
                        {feed ? ` · ${isLocal ? 'You' : peerLabel(typeof feed === 'string' ? feed : '')}` : ' · empty'}
                      </span>
                      {isLocal && (
                        <>
                          <button type="button" className="secondary" onClick={openBackgroundPicker}>
                            Background
                          </button>
                          {virtualBgUrl && (
                            <button type="button" className="secondary" onClick={clearVirtualBgAndCloseMenu}>
                              Clear bg
                            </button>
                          )}
                        </>
                      )}
                      {feed !== null && (
                        <div className="stage-slot-picker-section" role="group" aria-label="Move to cam">
                          <span className="stage-slot-picker-heading">Move to</span>
                          {Array.from({ length: 7 }, (_, to) =>
                            to === index ? null : (
                              <button
                                key={`portal-move-${index}-${to}`}
                                type="button"
                                className="secondary stage-slot-move-btn"
                                onClick={() => moveStageOccupant(index, to)}
                              >
                                → {slotCamLabel(to)}
                              </button>
                            ),
                          )}
                        </div>
                      )}
                      <div className="stage-slot-picker-section" role="group" aria-label="Put person here">
                        <span className="stage-slot-picker-heading">
                          {feed === null ? 'Add to this cam' : 'Replace with'}
                        </span>
                        {!selfAlreadyHere && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => assignStageSlot(index, '__local')}
                          >
                            Put me here
                          </button>
                        )}
                        {placeablePeers.map((pid) => (
                          <button
                            key={pid}
                            type="button"
                            className="secondary"
                            onClick={() => assignStageSlot(index, pid)}
                          >
                            Put {peerLabel(pid)} here
                          </button>
                        ))}
                        {placeablePeers.length === 0 && selfAlreadyHere && (
                          <span className="stage-slot-picker-empty">Everyone already placed — use Move to</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          void shareInviteLink()
                          closeSlotMenu()
                        }}
                      >
                        Share invite
                      </button>
                      {feed !== null && typeof feed === 'string' && !isLocal && (
                        <>
                          <button type="button" className="secondary" onClick={() => assignStageSlot(index, null)}>
                            Clear slot
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setHostMuteUser(feed, !hostMutedIds.includes(feed))}
                          >
                            {hostMutedIds.includes(feed) ? 'Unmute mic' : 'Mute mic'}
                          </button>
                          <button type="button" className="secondary live-host-kick" onClick={() => kickLiveMember(feed)}>
                            Kick {peerLabel(feed)}
                          </button>
                          <button type="button" className="secondary live-host-ban" onClick={() => banLiveMember(feed)}>
                            Ban {peerLabel(feed)}
                          </button>
                        </>
                      )}
                      {isLocal && feed !== null && (
                        <button type="button" className="secondary" onClick={() => assignStageSlot(index, null)}>
                          Leave this cam
                        </button>
                      )}
                      <button type="button" className="secondary" onClick={closeSlotMenu}>
                        Close
                      </button>
                    </>
                  )
                })()}
              </div>,
              document.body,
            )}
          {showMobileRoomFooter && createPortal(<MobileRoomFooterNav portaled />, document.body)}
        </div>
      ) : !err ? (
        <div className={`live-grid ${pinnedPeer ? 'has-pin' : ''}`}>
          <div className="room-audio-mix" aria-hidden>
            {remoteOrder.map((pid) => {
              const stream = remoteStreams[pid]
              if (!stream) return null
              return (
                <RemotePeerAudio
                  key={`peer-audio-${pid}`}
                  peerId={pid}
                  stream={stream}
                  silenced={hostMutedIds.includes(pid)}
                />
              )
            })}
          </div>
          <button
            type="button"
            className={`live-tile ${pinnedPeer === '__local' ? 'spotlight' : ''}`}
            onClick={() => setPinnedPeer((p) => (p === '__local' ? null : '__local'))}
            title="Pin your tile"
          >
            <span className="live-label">{ghostMode ? 'You (ghost)' : 'You'}</span>
            <LocalStageVideo videoRef={localRef} stream={localStream} className={ghostMode ? 'dim' : ''} />
            {!isCapacitorApp() && (
              <CamVolumeMeter stream={localStream} active={micOn && !ghostMode} compact />
            )}
          </button>
          {remoteOrder.map((pid) => {
            const stream = remoteStreams[pid]
            if (!stream) return null
            return (
              <button
                type="button"
                key={pid}
                className={`live-tile ${pinnedPeer === pid ? 'spotlight' : ''}`}
                onClick={() => setPinnedPeer((p) => (p === pid ? null : pid))}
                title="Pin this guest"
              >
                <span className="live-label">{peerLabel(pid)}</span>
                <RemoteVideo stream={stream} />
                {!isCapacitorApp() && <CamVolumeMeter stream={stream} compact />}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function RemotePeerAudio({
  peerId,
  stream,
  silenced = false,
}: {
  peerId: string
  stream: MediaStream
  silenced?: boolean
}) {
  const ref = useRef<HTMLAudioElement>(null)

  const playAudio = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.muted = silenced
    el.volume = silenced ? 0 : 1
    /* Mic-only peers still deliver audio on the same MediaStream (no video required). */
    if (el.srcObject !== stream) el.srcObject = stream
    el.setAttribute('playsinline', 'true')
    el.setAttribute('webkit-playsinline', 'true')
    void el.play().catch(() => {})
  }, [stream, silenced])

  useEffect(() => {
    playAudio()
    const onTrackChange = () => playAudio()
    stream.addEventListener('addtrack', onTrackChange)
    stream.addEventListener('removetrack', onTrackChange)
    stream.getTracks().forEach((track) => {
      track.addEventListener('unmute', onTrackChange)
      track.addEventListener('ended', onTrackChange)
    })
    const onVisible = () => {
      if (document.visibilityState === 'visible') playAudio()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onVisible)
    window.addEventListener('focus', onVisible)
    const kick = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      const el = ref.current
      if (!el || !el.srcObject) return
      el.muted = silenced
      /* Skip play() churn when audio is already running — APK heat saver. */
      if (!silenced && !el.paused && el.srcObject === stream) return
      if (!silenced && el.paused) playAudio()
      if (
        !silenced &&
        stream.getAudioTracks().some((t) => t.readyState === 'live') &&
        el.srcObject !== stream
      ) {
        playAudio()
      }
    }, peerAudioKickMs())
    return () => {
      window.clearInterval(kick)
      stream.removeEventListener('addtrack', onTrackChange)
      stream.removeEventListener('removetrack', onTrackChange)
      stream.getTracks().forEach((track) => {
        track.removeEventListener('unmute', onTrackChange)
        track.removeEventListener('ended', onTrackChange)
      })
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [stream, playAudio, silenced])

  return (
    <audio
      ref={ref}
      autoPlay
      playsInline
      muted={silenced}
      preload="auto"
      className="room-peer-audio"
      data-peer-id={peerId}
      aria-label={`Audio from ${peerId.slice(-4)}`}
    />
  )
}

/** Video-only tile — room audio is mixed via `RemotePeerAudio` (one sink per peer). */
function RemoteVideo({
  stream,
  className,
  remountEpoch = 0,
}: {
  stream: MediaStream
  className?: string
  remountEpoch?: number
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const boundStreamRef = useRef<MediaStream | null>(null)
  const lastForceAtRef = useRef(0)

  const playVideo = useCallback(
    (forceRebind = false) => {
      const el = ref.current
      if (!el || !stream) return
      const now = Date.now()
      const alreadyBound = boundStreamRef.current === stream && el.srcObject === stream
      /*
       * Chrome: do NOT null+rebind or call load() just because videoWidth is still 0.
       * First frames can take a moment; aggressive rebind keeps the tile black forever.
       */
      const shouldRebind =
        forceRebind ||
        !alreadyBound ||
        el.srcObject !== stream

      if (shouldRebind) {
        try {
          if (el.srcObject !== stream) {
            el.srcObject = stream
          }
        } catch {
          el.srcObject = stream
        }
        boundStreamRef.current = stream
        lastForceAtRef.current = now
      }

      el.muted = true
      el.defaultMuted = true
      el.playsInline = true
      el.setAttribute('playsinline', 'true')
      el.setAttribute('webkit-playsinline', 'true')
      el.setAttribute('muted', '')

      const kick = () => {
        void el.play().catch(() => {
          window.setTimeout(() => {
            void el.play().catch(() => {})
          }, 120)
        })
      }
      kick()
    },
    [stream],
  )

  useEffect(() => {
    boundStreamRef.current = null
    playVideo(true)

    const onTrackChange = () => {
      boundStreamRef.current = null
      playVideo(true)
    }
    stream.addEventListener('addtrack', onTrackChange)
    stream.addEventListener('removetrack', onTrackChange)
    stream.getTracks().forEach((track) => {
      track.addEventListener('unmute', onTrackChange)
      track.addEventListener('mute', onTrackChange)
      track.addEventListener('ended', onTrackChange)
    })

    const onVisible = () => {
      if (document.visibilityState === 'visible') playVideo(false)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onVisible)
    window.addEventListener('focus', onVisible)

    let kickTimer: number | null = null
    let kickDelay = peerVideoKickMs()
    const maxKickDelay = peerVideoKickMaxMs()
    const adaptiveKick = isNativePowerSave()

    const runKick = () => {
      if (document.visibilityState === 'hidden') {
        if (kickTimer != null) clearTimeout(kickTimer)
        kickTimer = window.setTimeout(runKick, Math.max(kickDelay, 2000))
        return
      }
      const v = ref.current
      if (!v) {
        kickDelay = adaptiveKick ? Math.min(kickDelay * 1.35, maxKickDelay) : peerVideoKickMs()
        kickTimer = window.setTimeout(runKick, kickDelay)
        return
      }
      const hasLiveVideo = stream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled)
      if (v.srcObject !== stream) {
        playVideo(true)
        kickDelay = peerVideoKickMs()
      } else if (v.paused) {
        playVideo(false)
        kickDelay = peerVideoKickMs()
      } else if (hasLiveVideo && v.videoWidth > 0 && !v.paused) {
        /* Healthy playing frame — back off timers on APK. */
        kickDelay = adaptiveKick ? Math.min(kickDelay * 1.4, maxKickDelay) : peerVideoKickMs()
      } else if (hasLiveVideo && v.videoWidth === 0 && Date.now() - lastForceAtRef.current > 2500) {
        try {
          v.srcObject = stream
        } catch {
          /* ignore */
        }
        lastForceAtRef.current = Date.now()
        void v.play().catch(() => {})
        kickDelay = peerVideoKickMs()
      } else {
        kickDelay = adaptiveKick ? Math.min(kickDelay * 1.2, maxKickDelay) : peerVideoKickMs()
      }
      kickTimer = window.setTimeout(runKick, kickDelay)
    }
    kickTimer = window.setTimeout(runKick, kickDelay)

    return () => {
      if (kickTimer != null) clearTimeout(kickTimer)
      stream.removeEventListener('addtrack', onTrackChange)
      stream.removeEventListener('removetrack', onTrackChange)
      stream.getTracks().forEach((track) => {
        track.removeEventListener('unmute', onTrackChange)
        track.removeEventListener('mute', onTrackChange)
        track.removeEventListener('ended', onTrackChange)
      })
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [stream, playVideo, remountEpoch])

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      disablePictureInPicture
      className={`live-video ${className ?? ''}`.trim()}
      {...({ webkitPlaysinline: 'true', x5Playsinline: 'true' } as React.VideoHTMLAttributes<HTMLVideoElement>)}
    />
  )
}

function CameraBattleEffect({
  hit,
  slotIndex,
  stageRefsMap,
}: {
  hit: BattleCameraHit
  slotIndex: number
  stageRefsMap: React.MutableRefObject<Map<number, HTMLDivElement>>
}) {
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties | null>(null)
  const [videoFailed, setVideoFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const cssFxOnly = preferCssBattleFx()
  const hue = fxHue(hit.giftId)

  useEffect(() => {
    setVideoFailed(false)
  }, [hit.id, hit.videoSrc])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !hit.videoSrc || videoFailed) return
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    const tryPlay = () => {
      void video.play().catch(() => setVideoFailed(true))
    }
    tryPlay()
    video.addEventListener('loadeddata', tryPlay)
    return () => video.removeEventListener('loadeddata', tryPlay)
  }, [hit.id, hit.videoSrc, videoFailed])

  useLayoutEffect(() => {
    let raf = 0
    let alive = true
    const sync = () => {
      if (!alive) return
      const el = stageRefsMap.current.get(slotIndex) ?? null
      if (!el) {
        setPortalStyle((prev) => (prev === null ? prev : null))
        return
      }
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) {
        setPortalStyle((prev) => (prev === null ? prev : null))
        return
      }
      const radius = getComputedStyle(el).borderRadius || '14px'
      const next: React.CSSProperties = {
        position: 'fixed',
        zIndex: cssFxOnly ? 99999 : 9500,
        pointerEvents: 'none',
        overflow: 'hidden',
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        borderRadius: radius,
      }
      setPortalStyle((prev) => {
        if (
          prev &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.width === next.width &&
          prev.height === next.height
        ) {
          return prev
        }
        return next
      })
    }
    sync()
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(sync)
    }
    window.addEventListener('resize', schedule, { passive: true })
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    const el = stageRefsMap.current.get(slotIndex)
    const ro = typeof ResizeObserver !== 'undefined' && el ? new ResizeObserver(schedule) : null
    if (el && ro) ro.observe(el)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      ro?.disconnect()
    }
  }, [slotIndex, hit.id, stageRefsMap, cssFxOnly])

  if (!portalStyle) return null

  const style = {
    '--fx-hue': `${hue}deg`,
    '--fx-hue-2': `${(hue + 82) % 360}deg`,
  } as React.CSSProperties

  const title = (
    <div className="fx-title">
      <strong>{hit.giftName}</strong>
      <span>{hit.weapon}</span>
    </div>
  )

  const fxClass = hit.effectClass ? ` camera-battle-fx--${hit.effectClass}` : ''
  const useVideo = Boolean(hit.videoSrc) && !videoFailed

  const cssBurst = (
    <span className="camera-battle-fx-weapon" aria-hidden>
      {hit.weapon}
    </span>
  )

  const inner = useVideo ? (
    <div
      className={`camera-battle-video-fx${hit.giftId === 'golden-rose' ? ' camera-battle-video-fx--legendary' : ''}`}
      style={style}
      aria-hidden
    >
      <video
        ref={videoRef}
        src={hit.videoSrc}
        autoPlay
        muted
        playsInline
        preload="auto"
        className="camera-battle-video-fx__video"
        onError={() => setVideoFailed(true)}
        {...({ webkitPlaysinline: 'true' } as React.VideoHTMLAttributes<HTMLVideoElement>)}
      />
      {title}
    </div>
  ) : (
    <div className={`camera-battle-fx${fxClass}${cssFxOnly ? ' camera-battle-fx--css-only' : ''}`} style={style} aria-hidden>
      {!cssFxOnly ? <BattleThreeEffect hit={hit} /> : cssBurst}
      {title}
    </div>
  )

  return createPortal(
    <div className="battle-fx-portal" style={portalStyle} aria-hidden>
      {inner}
    </div>,
    document.body,
  )
}
