const LOGIN_KEY_STORAGE_PREFIX = 'orion_login_identity_v1.'
const LOGIN_VERIFIED_STORAGE_PREFIX = 'orion_login_verified_v1.'
const enc = new TextEncoder()

type StoredLoginIdentity = {
  privJwk: JsonWebKey
  pubJwk: JsonWebKey
}

export type OrionLoginVerification = {
  verified: boolean
  publicJwk: string
  challengeB64: string
  signatureB64: string
}

function storageKey(userId: string) {
  return `${LOGIN_KEY_STORAGE_PREFIX}${userId}`
}

/** Keyed by userId only — sessionStorage lifetime (tab close) is the security boundary. */
function verifiedStorageKey(userId: string) {
  return `${LOGIN_VERIFIED_STORAGE_PREFIX}${userId}`
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

function fromB64(value: string): Uint8Array {
  const bin = atob(value)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)!
  return out
}

function stablePublicJwkJson(jwk: JsonWebKey): string {
  return JSON.stringify({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    ext: true,
    key_ops: ['verify'],
  })
}

async function importPublicKey(publicJwkJson: string): Promise<CryptoKey> {
  const jwk = JSON.parse(publicJwkJson) as JsonWebKey
  return crypto.subtle.importKey(
    'jwk',
    { ...jwk, key_ops: ['verify'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  )
}

export function readOrionKeyVerified(userId: string): boolean {
  if (typeof sessionStorage === 'undefined') return false
  try {
    return sessionStorage.getItem(verifiedStorageKey(userId)) === '1'
  } catch {
    return false
  }
}

export function markOrionKeyVerified(userId: string) {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(verifiedStorageKey(userId), '1')
  } catch {
    /* ignore */
  }
}

export function clearOrionKeyVerified(userId?: string) {
  if (typeof sessionStorage === 'undefined') return
  try {
    if (userId) {
      sessionStorage.removeItem(verifiedStorageKey(userId))
    } else {
      for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
        const key = sessionStorage.key(i)
        if (key?.startsWith(LOGIN_VERIFIED_STORAGE_PREFIX)) sessionStorage.removeItem(key)
      }
    }
  } catch {
    /* ignore */
  }
}

export function clearOrionLoginIdentity(userId: string) {
  try {
    localStorage.removeItem(storageKey(userId))
  } catch {
    /* ignore */
  }
  clearOrionKeyVerified(userId)
}

export async function getOrCreateOrionLoginIdentity(userId: string): Promise<CryptoKeyPair & { publicJwkJson: string }> {
  const raw = localStorage.getItem(storageKey(userId))
  if (raw) {
    try {
      const stored = JSON.parse(raw) as StoredLoginIdentity
      const publicKey = await importPublicKey(stablePublicJwkJson(stored.pubJwk))
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        stored.privJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
      )
      return { publicKey, privateKey, publicJwkJson: stablePublicJwkJson(stored.pubJwk) }
    } catch {
      localStorage.removeItem(storageKey(userId))
    }
  }

  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  localStorage.setItem(storageKey(userId), JSON.stringify({ privJwk, pubJwk }))
  return { ...pair, publicJwkJson: stablePublicJwkJson(pubJwk) }
}

export async function verifyOrionLoginKey(userId: string, expectedPublicJwkJson?: string | null): Promise<OrionLoginVerification> {
  const identity = await getOrCreateOrionLoginIdentity(userId)
  const expected = expectedPublicJwkJson?.trim() || identity.publicJwkJson
  if (expected !== identity.publicJwkJson) {
    return {
      verified: false,
      publicJwk: identity.publicJwkJson,
      challengeB64: '',
      signatureB64: '',
    }
  }

  const nonce = new Uint8Array(32)
  crypto.getRandomValues(nonce)
  const challenge = enc.encode(`orion-login-v1.${userId}.${Date.now()}.${b64(nonce)}`)
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, challenge)
  const publicKey = await importPublicKey(expected)
  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature,
    challenge,
  )

  return {
    verified,
    publicJwk: identity.publicJwkJson,
    challengeB64: b64(challenge),
    signatureB64: b64(new Uint8Array(signature)),
  }
}

export async function verifyStoredOrionChallenge(publicJwkJson: string, challengeB64: string, signatureB64: string) {
  const publicKey = await importPublicKey(publicJwkJson)
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    fromB64(signatureB64),
    fromB64(challengeB64),
  )
}
