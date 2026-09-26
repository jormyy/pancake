// Standards Web Push sender for installed PWAs (iOS 16.4+ home-screen apps,
// Chromium, Firefox). Implemented directly on WebCrypto because the common
// `web-push` package depends on Node crypto internals.
//   - RFC 8291: message encryption (ECDH P-256 + HKDF + AES-128-GCM)
//   - RFC 8188: aes128gcm content coding (single record)
//   - RFC 8292: VAPID application-server authentication (ES256 JWT)

const PUSH_TIMEOUT_MS = 8000
const RECORD_SIZE = 4096
// A single aes128gcm record holds at most rs - 16 (tag) - 1 (delimiter) bytes,
// and the header adds 86 bytes. Push services cap bodies at 4096 bytes total.
export const MAX_WEB_PUSH_PAYLOAD_BYTES = 3993
const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60
const DEFAULT_TTL_SECONDS = 24 * 60 * 60

// Only push-service origins may receive server-side POSTs; the endpoint URL is
// client-supplied, so anything else would turn the sender into an SSRF relay.
const PUSH_SERVICE_HOSTS = new Set(['fcm.googleapis.com'])
const PUSH_SERVICE_HOST_SUFFIXES = [
  '.push.apple.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
]

export type WebPushSubscription = {
  endpoint: string
  p256dh: string
  auth: string
}

export type VapidKeys = {
  /** base64url uncompressed P-256 public key (65 bytes) */
  publicKey: string
  /** base64url P-256 private scalar (32 bytes) */
  privateKey: string
  /** mailto: or https: contact for the push service operator */
  subject: string
}

export type WebPushOptions = {
  ttlSeconds?: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  /** Collapses undelivered messages that share a topic (max 32 url-safe chars). */
  topic?: string
}

export type WebPushResult =
  | { outcome: 'sent' }
  | { outcome: 'gone'; status: number }
  | { outcome: 'failed'; status: number | null; retryable: boolean; message: string }

type EncryptionOverrides = {
  salt?: Uint8Array<ArrayBuffer>
  localKeys?: CryptoKeyPair
}

const encoder = new TextEncoder()

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  return PUSH_SERVICE_HOSTS.has(host) || PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/** Throws when the subscription keys are not a P-256 point and a 16-byte secret. */
export function assertSubscriptionKeys(subscription: Pick<WebPushSubscription, 'p256dh' | 'auth'>): void {
  const publicKey = base64UrlDecode(subscription.p256dh)
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error('p256dh must be an uncompressed P-256 key')
  if (base64UrlDecode(subscription.auth).length !== 16) throw new Error('auth must be 16 bytes')
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8)
  return new Uint8Array(bits)
}

/** RFC 8291 aes128gcm body: salt(16) | rs(4) | idlen(1) | keyid(65) | ciphertext. */
export async function encryptWebPushPayload(
  subscription: Pick<WebPushSubscription, 'p256dh' | 'auth'>,
  plaintext: Uint8Array,
  overrides: EncryptionOverrides = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_WEB_PUSH_PAYLOAD_BYTES) {
    throw new RangeError(`Web push payload exceeds ${MAX_WEB_PUSH_PAYLOAD_BYTES} bytes`)
  }
  const userAgentPublic = base64UrlDecode(subscription.p256dh)
  const authSecret = base64UrlDecode(subscription.auth)
  const userAgentKey = await crypto.subtle.importKey(
    'raw',
    userAgentPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const localKeys = overrides.localKeys ?? await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair
  const localPublic = new Uint8Array(await crypto.subtle.exportKey('raw', localKeys.publicKey))
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: userAgentKey },
    localKeys.privateKey,
    256,
  ))

  const keyInfo = concat(encoder.encode('WebPush: info\0'), userAgentPublic, localPublic)
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32)
  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const contentKey = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt'])
  // 0x02 marks the final (and only) record; no extra padding.
  const record = concat(plaintext, new Uint8Array([0x02]))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record))

  const header = new Uint8Array(21)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = localPublic.length
  return concat(header, localPublic, ciphertext)
}

const signingKeys = new Map<string, Promise<CryptoKey>>()

function vapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const cacheKey = `${keys.publicKey}:${keys.privateKey}`
  let key = signingKeys.get(cacheKey)
  if (!key) {
    const publicKey = base64UrlDecode(keys.publicKey)
    if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
      throw new Error('VAPID public key must be an uncompressed P-256 key')
    }
    key = crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: base64UrlEncode(publicKey.slice(1, 33)),
        y: base64UrlEncode(publicKey.slice(33, 65)),
        d: keys.privateKey,
        ext: false,
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    key.catch(() => signingKeys.delete(cacheKey))
    signingKeys.set(cacheKey, key)
  }
  return key
}

/** RFC 8292 `Authorization: vapid t=<jwt>, k=<public key>` header value. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, nowMs = Date.now()): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + VAPID_TOKEN_TTL_SECONDS,
    sub: keys.subject,
  })))
  const unsigned = `${header}.${claims}`
  // WebCrypto ECDSA output is already the raw r||s form JWS requires.
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await vapidSigningKey(keys),
    encoder.encode(unsigned),
  ))
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${keys.publicKey}`
}

export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: unknown,
  keys: VapidKeys,
  options: WebPushOptions = {},
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<WebPushResult> {
  if (!isAllowedPushEndpoint(subscription.endpoint)) {
    return { outcome: 'failed', status: null, retryable: false, message: 'Endpoint is not a recognised push service' }
  }

  let body: Uint8Array<ArrayBuffer>
  try {
    body = await encryptWebPushPayload(subscription, encoder.encode(JSON.stringify(payload)))
  } catch (error) {
    if (error instanceof RangeError) {
      return { outcome: 'failed', status: null, retryable: false, message: error.message }
    }
    // Stored keys that WebCrypto rejects can never encrypt; the subscription is unusable.
    return { outcome: 'gone', status: 0 }
  }
  // VAPID failures are server configuration errors and must surface, not prune subscriptions.
  const authorization = await vapidAuthorization(subscription.endpoint, keys)

  const headers: Record<string, string> = {
    Authorization: authorization,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    Urgency: options.urgency ?? 'normal',
  }
  if (options.topic) headers.Topic = options.topic

  let response: Response
  try {
    response = await send(subscription.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
  } catch (error) {
    return {
      outcome: 'failed',
      status: null,
      retryable: true,
      message: error instanceof Error ? error.message : 'Web push request failed',
    }
  }

  const status = response.status
  const detail = await response.text().catch(() => '')
  if (status >= 200 && status < 300) return { outcome: 'sent' }
  // 404/410: the subscription expired or was revoked by the user agent.
  if (status === 404 || status === 410) return { outcome: 'gone', status }
  return {
    outcome: 'failed',
    status,
    retryable: status === 429 || status >= 500,
    message: `Push service returned HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
  }
}
