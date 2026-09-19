import { useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { Profile } from '../lib/supabase'
import { supabase } from '../lib/supabase'
import {
  createNodeHeartbeat,
  defaultNodePolicy,
  getOrCreateNodeIdentity,
  ORION_NODE_CHANNEL,
  signNodePayload,
  verifyNodeEnvelope,
  type OrionNetworkClass,
  type OrionNodeCapability,
  type OrionNodeHeartbeat,
  type OrionNodeIdentity,
  type OrionNodePolicy,
  type OrionSignedEnvelope,
} from '../lib/orionNodeProtocol'

const NODE_SETTINGS_KEY = 'orion_node_mode_settings_v1'

type NodePeer = {
  heartbeat: OrionNodeHeartbeat
  verified: boolean
  receivedAt: number
}

type BatterySnapshot = {
  batteryPercent: number | null
  isCharging: boolean | null
}

type NavigatorWithBattery = Navigator & {
  getBattery?: () => Promise<{ level: number; charging: boolean }>
  connection?: { type?: string; effectiveType?: string }
}

function readSavedPolicy(): OrionNodePolicy {
  try {
    const raw = localStorage.getItem(NODE_SETTINGS_KEY)
    if (!raw) return defaultNodePolicy()
    return { ...defaultNodePolicy(), ...(JSON.parse(raw) as Partial<OrionNodePolicy>) }
  } catch {
    return defaultNodePolicy()
  }
}

function savePolicy(policy: OrionNodePolicy) {
  localStorage.setItem(NODE_SETTINGS_KEY, JSON.stringify(policy))
}

function networkClass(): OrionNetworkClass {
  if (!navigator.onLine) return 'OFFLINE'
  const nav = navigator as NavigatorWithBattery
  const kind = `${nav.connection?.type ?? nav.connection?.effectiveType ?? ''}`.toLowerCase()
  if (kind.includes('cellular') || /(^|-)2g|(^|-)3g|(^|-)4g|(^|-)5g/.test(kind)) return 'CELLULAR'
  if (kind.includes('wifi')) return 'WIFI'
  if (kind.includes('ethernet')) return 'ETHERNET'
  return 'UNKNOWN'
}

async function readBattery(): Promise<BatterySnapshot> {
  const nav = navigator as NavigatorWithBattery
  if (!nav.getBattery) return { batteryPercent: null, isCharging: null }
  try {
    const battery = await nav.getBattery()
    return { batteryPercent: Math.round(battery.level * 100), isCharging: battery.charging }
  } catch {
    return { batteryPercent: null, isCharging: null }
  }
}

function capabilities(): OrionNodeCapability[] {
  return ['WEBRTC_SIGNAL', 'DATA_RELAY', 'STORE_FORWARD', 'MEDIA_MESH']
}

function compactTime(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso))
}

export default function NodeModePanel({ profile }: { profile: Profile }) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem('orion_node_mode_enabled_v1') === 'true')
  const [policy, setPolicy] = useState<OrionNodePolicy>(() => readSavedPolicy())
  const [identity, setIdentity] = useState<OrionNodeIdentity | null>(null)
  const [lastHeartbeat, setLastHeartbeat] = useState<OrionNodeHeartbeat | null>(null)
  const [peers, setPeers] = useState<Record<string, NodePeer>>({})
  const [statusText, setStatusText] = useState('Standing by')
  const channelRef = useRef<RealtimeChannel | null>(null)

  const activePeers = useMemo(
    () =>
      Object.values(peers)
        .filter((peer) => new Date(peer.heartbeat.expiresAt).getTime() > Date.now())
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, 6),
    [peers],
  )

  useEffect(() => {
    localStorage.setItem('orion_node_mode_enabled_v1', String(enabled))
  }, [enabled])

  useEffect(() => {
    savePolicy(policy)
  }, [policy])

  useEffect(() => {
    void getOrCreateNodeIdentity(profile.id).then(setIdentity)
  }, [profile.id])

  useEffect(() => {
    if (!enabled || !identity || !supabase) {
      channelRef.current?.unsubscribe()
      channelRef.current = null
      return
    }

    const nodeIdentity = identity
    let closed = false
    let interval: number | null = null
    const channel = supabase.channel(ORION_NODE_CHANNEL, {
      config: { broadcast: { self: false } },
    })
    channelRef.current = channel

    channel.on('broadcast', { event: 'heartbeat' }, async ({ payload }) => {
      const envelope = payload as OrionSignedEnvelope<OrionNodeHeartbeat>
      if (envelope?.payload?.nodeId === nodeIdentity.nodeId) return
      const verified = await verifyNodeEnvelope(envelope)
      if (!verified || envelope.payload.kind !== 'NODE_HEARTBEAT') return
      setPeers((current) => ({
        ...current,
        [envelope.payload.nodeId]: {
          heartbeat: envelope.payload,
          verified,
          receivedAt: Date.now(),
        },
      }))
    })

    async function sendHeartbeat() {
      if (closed) return
      const battery = await readBattery()
      const heartbeat = await createNodeHeartbeat({
        identity: nodeIdentity,
        userId: profile.id,
        displayName: profile.display_name,
        policy,
        role: 'BROWSER_ACTIVE',
        capabilities: capabilities(),
        batteryPercent: battery.batteryPercent,
        isCharging: battery.isCharging,
        networkClass: networkClass(),
      })
      const envelope = await signNodePayload(profile.id, nodeIdentity, heartbeat)
      setLastHeartbeat(heartbeat)
      setStatusText(heartbeat.status === 'ONLINE' ? 'Broadcasting signed heartbeats' : 'Node paused by policy')
      await channel.send({ type: 'broadcast', event: 'heartbeat', payload: envelope })
    }

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setStatusText('Connected to global heartbeat channel')
        void sendHeartbeat()
        interval = window.setInterval(() => void sendHeartbeat(), 15_000)
      }
    })

    return () => {
      closed = true
      if (interval !== null) window.clearInterval(interval)
      channel.unsubscribe()
      if (channelRef.current === channel) channelRef.current = null
    }
  }, [enabled, identity, policy, profile.display_name, profile.id])

  return (
    <section className="card elevate node-panel" aria-labelledby="node-mode-title">
      <div className="node-panel-head">
        <div>
          <div className="live-map-kicker">Edge mesh</div>
          <h3 id="node-mode-title" className="section-title">
            Phone Node Mode
          </h3>
          <p className="page-intro node-copy">
            Turn this device into an opt-in Orion node. It broadcasts signed heartbeats now and is ready for WebRTC
            relays, store-forward envelopes, and native phone clients using the same contract.
          </p>
        </div>
        <button
          className={enabled ? 'secondary node-toggle node-toggle--on' : 'primary node-toggle'}
          type="button"
          onClick={() => setEnabled((value) => !value)}
          aria-pressed={enabled}
        >
          {enabled ? 'Node on' : 'Start node'}
        </button>
      </div>

      <div className="node-grid">
        <div className="node-stat">
          <span>Node ID</span>
          <strong>{identity?.nodeId ?? 'generating'}</strong>
        </div>
        <div className="node-stat">
          <span>Status</span>
          <strong>{lastHeartbeat?.status ?? (enabled ? 'CONNECTING' : 'OFFLINE')}</strong>
        </div>
        <div className="node-stat">
          <span>Network</span>
          <strong>{lastHeartbeat?.networkClass ?? networkClass()}</strong>
        </div>
        <div className="node-stat">
          <span>Battery</span>
          <strong>
            {lastHeartbeat?.batteryPercent === null || lastHeartbeat?.batteryPercent === undefined
              ? 'unknown'
              : `${lastHeartbeat.batteryPercent}%`}
          </strong>
        </div>
      </div>

      <div className="node-policy" aria-label="Node policy">
        <label>
          <span>Region</span>
          <select
            value={policy.region}
            onChange={(e) => setPolicy((current) => ({ ...current, region: e.target.value }))}
          >
            <option value="auto">Auto</option>
            <option value="eu-west">EU West</option>
            <option value="us-east">US East</option>
            <option value="us-west">US West</option>
            <option value="asia">Asia</option>
          </select>
        </label>
        <label>
          <span>Min battery</span>
          <input
            type="number"
            min={5}
            max={95}
            step={5}
            value={policy.minBatteryPercent}
            onChange={(e) =>
              setPolicy((current) => ({ ...current, minBatteryPercent: Number(e.target.value) || 35 }))
            }
          />
        </label>
        <label>
          <span>Relay cap MB/h</span>
          <input
            type="number"
            min={16}
            max={2048}
            step={16}
            value={policy.maxRelayMbPerHour}
            onChange={(e) =>
              setPolicy((current) => ({ ...current, maxRelayMbPerHour: Number(e.target.value) || 128 }))
            }
          />
        </label>
        <label className="node-check">
          <input
            type="checkbox"
            checked={policy.allowCellular}
            onChange={(e) => setPolicy((current) => ({ ...current, allowCellular: e.target.checked }))}
          />
          <span>Allow cellular relay</span>
        </label>
        <label className="node-check">
          <input
            type="checkbox"
            checked={policy.chargingOnly}
            onChange={(e) => setPolicy((current) => ({ ...current, chargingOnly: e.target.checked }))}
          />
          <span>Charging only</span>
        </label>
      </div>

      <div className="node-status-line font-mono">
        <span>{statusText}</span>
        {lastHeartbeat && <span>last pulse {compactTime(lastHeartbeat.observedAt)}</span>}
      </div>

      <div className="node-peer-list" aria-label="Nearby Orion nodes">
        {activePeers.length === 0 ? (
          <div className="empty-hint">No other live nodes seen yet. Open Orion on another phone/tab and start Node Mode.</div>
        ) : (
          activePeers.map((peer) => (
            <div key={peer.heartbeat.nodeId} className="node-peer">
              <div>
                <strong>{peer.heartbeat.displayName}</strong>
                <span>{peer.heartbeat.nodeId}</span>
              </div>
              <div className="node-peer-meta">
                <span>{peer.heartbeat.region}</span>
                <span>{peer.heartbeat.status}</span>
                <span>{peer.verified ? 'SIGNED' : 'UNVERIFIED'}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
