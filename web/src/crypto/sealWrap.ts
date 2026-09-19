/**
 * Client-only ephemeral secrets for Orion: random bytes are encrypted to the peer's
 * public ECDH key and never stored in plaintext in Supabase. New sealed DMs also
 * encrypt/decrypt the message payload in browser, so the Orion secret does not
 * travel through the localhost bridge.
 * Private sealing keys remain in localStorage; operators never receive them.
 */

const STORAGE_KEY = 'orion_seal_identity_v1'
const ORION_BROWSER_TOKEN_PREFIX = 'orion-key-browser-v1.'
const enc = new TextEncoder()

function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)!
  return out
}

async function hkdfAes256(sharedSecret: ArrayBuffer): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('orion-social-seal-v1'), info: enc.encode('aes256') },
    material as CryptoKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function getOrCreateSealIdentity(): Promise<CryptoKeyPair> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const { privJwk, pubJwk } = JSON.parse(raw) as { privJwk: JsonWebKey; pubJwk: JsonWebKey }
      const pub = await crypto.subtle.importKey('jwk', pubJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        privJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits'],
      )
      return { publicKey: pub, privateKey }
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey as CryptoKey)
  const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey as CryptoKey)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ privJwk, pubJwk }))
  return pair as CryptoKeyPair
}

export async function sealPublicJwkString(pair: CryptoKeyPair): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return JSON.stringify(jwk)
}

/** Random 32 bytes as base64 (used as Orion `secret`) — wiped from JS heap after sealing; DB never sees this. */
export function randomOrionSecretB64(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return b64(b)
}

async function aesFromOrionSecret(secretPlain: string): Promise<CryptoKey> {
  const raw = fromB64(secretPlain)
  if (raw.byteLength !== 32) throw new Error('Invalid Orion browser secret length.')
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

function encodeJsonToken(payload: OrionBrowserToken): string {
  return `${ORION_BROWSER_TOKEN_PREFIX}${b64(enc.encode(JSON.stringify(payload)))}`
}

function decodeJsonToken(token: string): OrionBrowserToken {
  if (!token.startsWith(ORION_BROWSER_TOKEN_PREFIX)) throw new Error('Not a browser-native Orion token.')
  const json = new TextDecoder().decode(fromB64(token.slice(ORION_BROWSER_TOKEN_PREFIX.length)))
  return JSON.parse(json) as OrionBrowserToken
}

export async function wrapOrionSecretForPeer(peerPubJwkJson: string, secretPlain: string): Promise<SealEnvelopeWrap> {
  const peerPubJwk = JSON.parse(peerPubJwkJson) as JsonWebKey
  const peerPub = await crypto.subtle.importKey(
    'jwk',
    peerPubJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )

  const ephem = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, ephem.privateKey as CryptoKey, 256)
  const aes = await hkdfAes256(bits)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const pt = enc.encode(secretPlain)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, pt)
  const ephemPubJwk = await crypto.subtle.exportKey('jwk', ephem.publicKey as CryptoKey)
  return { ephemPubJwk, ivB64: b64(iv), cipherB64: b64(new Uint8Array(ct)) }
}

export type SealEnvelopeWrap = {
  ephemPubJwk: JsonWebKey
  ivB64: string
  cipherB64: string
}

export async function unwrapOrionSecret(recipientPrivateKey: CryptoKey, wrap: SealEnvelopeWrap): Promise<string> {
  const ephemPub = await crypto.subtle.importKey(
    'jwk',
    wrap.ephemPubJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemPub }, recipientPrivateKey, 256)
  const aes = await hkdfAes256(bits)
  const iv = fromB64(wrap.ivB64)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aes, fromB64(wrap.cipherB64))
  return new TextDecoder().decode(pt)
}

export type OrionBrowserSealInput = {
  plaintext: string
  timestampUtcIso: string
  lat: number
  lon: number
  elevationM: number
  secret?: string
}

export type OrionBrowserToken = {
  v: 1
  alg: 'AES-256-GCM'
  kdf_profile: 'browser-v1'
  timestamp_utc_iso: string
  observer: {
    lat: number
    lon: number
    elevation_m: number
  }
  ivB64: string
  cipherB64: string
}

export function isBrowserOrionToken(token: string): boolean {
  return token.startsWith(ORION_BROWSER_TOKEN_PREFIX)
}

export async function sealOrionInBrowser(input: OrionBrowserSealInput): Promise<{ token: string; secret: string }> {
  const secret = input.secret ?? randomOrionSecretB64()
  const aes = await aesFromOrionSecret(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const tokenBase = {
    v: 1,
    alg: 'AES-256-GCM',
    kdf_profile: 'browser-v1',
    timestamp_utc_iso: input.timestampUtcIso,
    observer: {
      lat: input.lat,
      lon: input.lon,
      elevation_m: input.elevationM,
    },
    ivB64: b64(iv),
  } satisfies Omit<OrionBrowserToken, 'cipherB64'>
  const aad = enc.encode(JSON.stringify(tokenBase))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aes, enc.encode(input.plaintext))
  return {
    secret,
    token: encodeJsonToken({ ...tokenBase, cipherB64: b64(new Uint8Array(cipher)) }),
  }
}

export async function openOrionInBrowser(token: string, secret: string): Promise<string> {
  const parsed = decodeJsonToken(token)
  if (parsed.v !== 1 || parsed.alg !== 'AES-256-GCM' || parsed.kdf_profile !== 'browser-v1') {
    throw new Error('Unsupported browser Orion token.')
  }
  const aes = await aesFromOrionSecret(secret)
  const { cipherB64, ...tokenBase } = parsed
  const aad = enc.encode(JSON.stringify(tokenBase))
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(parsed.ivB64), additionalData: aad },
    aes,
    fromB64(cipherB64),
  )
  return new TextDecoder().decode(pt)
}

export type OrionE2Body = {
  token: string
  wrap?: SealEnvelopeWrap
}

export const ORION_E2_PREFIX = '[ORION·E2]'
