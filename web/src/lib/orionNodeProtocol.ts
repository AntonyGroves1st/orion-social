export const ORION_NODE_PROTOCOL_VERSION = 'orion-node-v1'
export const ORION_NODE_CHANNEL = 'orion-node-heartbeats'

const NODE_IDENTITY_KEY = 'orion_node_identity_v1'
const enc = new TextEncoder()

export type OrionNodeRole = 'BROWSER_ACTIVE' | 'PHONE_ACTIVE' | 'PHONE_SLEEPING' | 'ANCHOR' | 'TURN_RELAY'

export type OrionNodeCapability =
  | 'WEBRTC_SIGNAL'
  | 'DATA_RELAY'
  | 'STORE_FORWARD'
  | 'MEDIA_MESH'
  | 'PUSH_WAKE'

export type OrionNetworkClass = 'UNKNOWN' | 'WIFI' | 'CELLULAR' | 'ETHERNET' | 'OFFLINE'

export type OrionNodePolicy = {
  region: string
  allowCellular: boolean
  chargingOnly: boolean
  minBatteryPercent: number
  maxRelayMbPerHour: number
}

export type OrionNodeIdentity = {
  nodeId: string
  createdAt: string
  publicKeyJwk: JsonWebKey
}

export type OrionNodeHeartbeat = {
  version: typeof ORION_NODE_PROTOCOL_VERSION
  kind: 'NODE_HEARTBEAT'
  nodeId: string
  userId: string
  displayName: string
  role: OrionNodeRole
  region: string
  capabilities: OrionNodeCapability[]
  policy: OrionNodePolicy
  status: 'ONLINE' | 'PAUSED'
  batteryPercent: number | null
  isCharging: boolean | null
  networkClass: OrionNetworkClass
  observedAt: string
  expiresAt: string
}

export type OrionSignedEnvelope<TPayload> = {
  version: typeof ORION_NODE_PROTOCOL_VERSION
  alg: 'ECDSA_P256_SHA256'
  publicKeyJwk: JsonWebKey
  payload: TPayload
  signatureB64: string
}

export type OrionHeartbeatInput = {
  identity: OrionNodeIdentity
  userId: string
  displayName: string
  policy: OrionNodePolicy
  role: OrionNodeRole
  capabilities: OrionNodeCapability[]
  batteryPercent: number | null
  isCharging: boolean | null
  networkClass: OrionNetworkClass
  now?: Date
}

type StoredIdentity = OrionNodeIdentity & {
  privateKeyJwk: JsonWebKey
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

function fromB64(raw: string): Uint8Array {
  const bin = atob(raw)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)!
  return bytes
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value))
  return hex(new Uint8Array(digest))
}

async function importPrivateSigningKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

async function importPublicSigningKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
}

export function defaultNodePolicy(region = 'auto'): OrionNodePolicy {
  return {
    region,
    allowCellular: false,
    chargingOnly: false,
    minBatteryPercent: 35,
    maxRelayMbPerHour: 128,
  }
}

export async function getOrCreateNodeIdentity(ownerId: string): Promise<OrionNodeIdentity> {
  const storageKey = `${NODE_IDENTITY_KEY}:${ownerId}`
  const raw = localStorage.getItem(storageKey)
  if (raw) {
    try {
      const stored = JSON.parse(raw) as StoredIdentity
      await importPrivateSigningKey(stored.privateKeyJwk)
      return {
        nodeId: stored.nodeId,
        createdAt: stored.createdAt,
        publicKeyJwk: stored.publicKeyJwk,
      }
    } catch {
      localStorage.removeItem(storageKey)
    }
  }

  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const nodeId = `node_${(await sha256Hex(canonicalJson(publicKeyJwk))).slice(0, 20)}`
  const stored: StoredIdentity = {
    nodeId,
    createdAt: new Date().toISOString(),
    publicKeyJwk,
    privateKeyJwk,
  }
  localStorage.setItem(storageKey, JSON.stringify(stored))
  return {
    nodeId,
    createdAt: stored.createdAt,
    publicKeyJwk,
  }
}

export async function createNodeHeartbeat(input: OrionHeartbeatInput): Promise<OrionNodeHeartbeat> {
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + 45_000)
  const shouldPauseForBattery =
    input.batteryPercent !== null && input.batteryPercent < input.policy.minBatteryPercent && input.isCharging !== true
  const shouldPauseForCharging = input.policy.chargingOnly && input.isCharging !== true
  const shouldPauseForCellular = !input.policy.allowCellular && input.networkClass === 'CELLULAR'

  return {
    version: ORION_NODE_PROTOCOL_VERSION,
    kind: 'NODE_HEARTBEAT',
    nodeId: input.identity.nodeId,
    userId: input.userId,
    displayName: input.displayName,
    role: input.role,
    region: input.policy.region,
    capabilities: input.capabilities,
    policy: input.policy,
    status: shouldPauseForBattery || shouldPauseForCharging || shouldPauseForCellular ? 'PAUSED' : 'ONLINE',
    batteryPercent: input.batteryPercent,
    isCharging: input.isCharging,
    networkClass: input.networkClass,
    observedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }
}

export async function signNodePayload<TPayload>(
  ownerId: string,
  identity: OrionNodeIdentity,
  payload: TPayload,
): Promise<OrionSignedEnvelope<TPayload>> {
  const raw = localStorage.getItem(`${NODE_IDENTITY_KEY}:${ownerId}`)
  if (!raw) throw new Error('Missing local Orion node signing key')
  const stored = JSON.parse(raw) as StoredIdentity
  const privateKey = await importPrivateSigningKey(stored.privateKeyJwk)
  const body = canonicalJson(payload)
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(body))
  return {
    version: ORION_NODE_PROTOCOL_VERSION,
    alg: 'ECDSA_P256_SHA256',
    publicKeyJwk: identity.publicKeyJwk,
    payload,
    signatureB64: b64(new Uint8Array(signature)),
  }
}

export async function verifyNodeEnvelope<TPayload>(envelope: OrionSignedEnvelope<TPayload>): Promise<boolean> {
  try {
    if (envelope.version !== ORION_NODE_PROTOCOL_VERSION || envelope.alg !== 'ECDSA_P256_SHA256') return false
    const publicKey = await importPublicSigningKey(envelope.publicKeyJwk)
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      fromB64(envelope.signatureB64),
      enc.encode(canonicalJson(envelope.payload)),
    )
  } catch {
    return false
  }
}

