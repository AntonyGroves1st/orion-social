import { createClient } from '@supabase/supabase-js'
import { webcrypto } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ORION_NODE_PROTOCOL_VERSION = 'orion-node-v1'
const ORION_NODE_CHANNEL = 'orion-node-heartbeats'
const KEY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.orion-anchor', 'identity.json')
const enc = new TextEncoder()
const subtle = webcrypto.subtle

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
const anchorName = process.env.ORION_ANCHOR_NAME || 'orion-anchor-local'
const anchorRegion = process.env.ORION_ANCHOR_REGION || 'auto'
const relayCap = Number(process.env.ORION_ANCHOR_RELAY_MB_PER_HOUR || '2048')

if (!supabaseUrl || !supabaseKey) {
  console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY, before starting the anchor.')
  process.exit(1)
}

function b64(bytes) {
  let raw = ''
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i])
  return Buffer.from(raw, 'binary').toString('base64')
}

function fromB64(raw) {
  return new Uint8Array(Buffer.from(raw, 'base64'))
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`
}

async function sha256Hex(value) {
  const digest = await subtle.digest('SHA-256', enc.encode(value))
  return hex(new Uint8Array(digest))
}

async function importPrivateSigningKey(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

async function importPublicSigningKey(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
}

async function getOrCreateIdentity() {
  try {
    const stored = JSON.parse(await readFile(KEY_PATH, 'utf8'))
    await importPrivateSigningKey(stored.privateKeyJwk)
    return stored
  } catch {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const privateKeyJwk = await subtle.exportKey('jwk', pair.privateKey)
    const publicKeyJwk = await subtle.exportKey('jwk', pair.publicKey)
    const nodeId = `anchor_${(await sha256Hex(canonicalJson(publicKeyJwk))).slice(0, 20)}`
    const stored = {
      nodeId,
      createdAt: new Date().toISOString(),
      publicKeyJwk,
      privateKeyJwk,
    }
    await mkdir(dirname(KEY_PATH), { recursive: true })
    await writeFile(KEY_PATH, JSON.stringify(stored, null, 2))
    return stored
  }
}

function createHeartbeat(identity) {
  const now = new Date()
  return {
    version: ORION_NODE_PROTOCOL_VERSION,
    kind: 'NODE_HEARTBEAT',
    nodeId: identity.nodeId,
    userId: identity.nodeId,
    displayName: anchorName,
    role: 'ANCHOR',
    region: anchorRegion,
    capabilities: ['WEBRTC_SIGNAL', 'DATA_RELAY', 'STORE_FORWARD'],
    policy: {
      region: anchorRegion,
      allowCellular: true,
      chargingOnly: false,
      minBatteryPercent: 0,
      maxRelayMbPerHour: relayCap,
    },
    status: 'ONLINE',
    batteryPercent: null,
    isCharging: true,
    networkClass: 'ETHERNET',
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 45_000).toISOString(),
  }
}

async function signPayload(identity, payload) {
  const privateKey = await importPrivateSigningKey(identity.privateKeyJwk)
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    enc.encode(canonicalJson(payload)),
  )
  return {
    version: ORION_NODE_PROTOCOL_VERSION,
    alg: 'ECDSA_P256_SHA256',
    publicKeyJwk: identity.publicKeyJwk,
    payload,
    signatureB64: b64(new Uint8Array(signature)),
  }
}

async function verifyEnvelope(envelope) {
  try {
    if (envelope.version !== ORION_NODE_PROTOCOL_VERSION || envelope.alg !== 'ECDSA_P256_SHA256') return false
    const publicKey = await importPublicSigningKey(envelope.publicKeyJwk)
    return subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      fromB64(envelope.signatureB64),
      enc.encode(canonicalJson(envelope.payload)),
    )
  } catch {
    return false
  }
}

const identity = await getOrCreateIdentity()
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const channel = supabase.channel(ORION_NODE_CHANNEL, {
  config: { broadcast: { self: false } },
})

const peers = new Map()

channel.on('broadcast', { event: 'heartbeat' }, async ({ payload }) => {
  if (payload?.payload?.nodeId === identity.nodeId) return
  if (!(await verifyEnvelope(payload))) return
  peers.set(payload.payload.nodeId, { heartbeat: payload.payload, receivedAt: Date.now() })
})

async function pulse() {
  const envelope = await signPayload(identity, createHeartbeat(identity))
  await channel.send({ type: 'broadcast', event: 'heartbeat', payload: envelope })
  const livePeers = [...peers.values()].filter((peer) => new Date(peer.heartbeat.expiresAt).getTime() > Date.now())
  console.log(
    `[${new Date().toISOString()}] ${identity.nodeId} heartbeat sent; live verified peers=${livePeers.length}`,
  )
}

channel.subscribe((status) => {
  if (status !== 'SUBSCRIBED') return
  console.log(`${anchorName} online as ${identity.nodeId} in ${anchorRegion}`)
  void pulse()
  setInterval(() => void pulse(), 15_000)
})

process.on('SIGINT', async () => {
  await channel.unsubscribe()
  process.exit(0)
})
