import {
  assertSubscriptionKeys,
  base64UrlDecode,
  base64UrlEncode,
  encryptWebPushPayload,
  isAllowedPushEndpoint,
  MAX_WEB_PUSH_PAYLOAD_BYTES,
  sendWebPush,
  vapidAuthorization,
  type VapidKeys,
  type WebPushSubscription,
} from './webPush.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: string | Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const infoBytes = typeof info === 'string' ? encoder.encode(info) : info
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: infoBytes }, key, length * 8))
}

// Browser-side keys: what PushManager.subscribe() would hold.
async function userAgent() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return { keys, publicRaw, auth, p256dh: base64UrlEncode(publicRaw), authB64: base64UrlEncode(auth) }
}

// Independent RFC 8291 receiver, as a user agent would decrypt.
async function decrypt(body: Uint8Array<ArrayBuffer>, ua: Awaited<ReturnType<typeof userAgent>>) {
  const salt = body.slice(0, 16)
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idLength = body[20]
  const senderPublic = body.slice(21, 21 + idLength)
  const ciphertext = body.slice(21 + idLength)
  assert(recordSize === 4096, `unexpected record size ${recordSize}`)

  const senderKey = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, ua.keys.privateKey, 256))
  const keyInfo = new Uint8Array([...encoder.encode('WebPush: info\0'), ...ua.publicRaw, ...senderPublic])
  const ikm = await hkdf(ua.auth, shared, keyInfo, 32)
  const cek = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16)
  const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ciphertext))
  let end = record.length - 1
  while (end >= 0 && record[end] === 0) end -= 1
  assert(record[end] === 0x02, 'final record delimiter missing')
  return decoder.decode(record.slice(0, end))
}

async function vapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { publicKey: base64UrlEncode(publicRaw), privateKey: jwk.d!, subject: 'mailto:ops@pancake.test' }
}

const ENDPOINT = 'https://web.push.apple.com/QGuQyavXutnMH-test'

async function subscription(): Promise<{ sub: WebPushSubscription; ua: Awaited<ReturnType<typeof userAgent>> }> {
  const ua = await userAgent()
  return { ua, sub: { endpoint: ENDPOINT, p256dh: ua.p256dh, auth: ua.authB64 } }
}

Deno.test('web push payload round-trips through an RFC 8291 receiver', async () => {
  const { sub, ua } = await subscription()
  const message = JSON.stringify({ title: 'Trade accepted', body: 'Welcome to the squad 🥞' })
  const body = await encryptWebPushPayload(sub, encoder.encode(message))
  assert(await decrypt(body, ua) === message, 'decrypted payload mismatch')
})

Deno.test('web push encryption uses a fresh salt and sender key per message', async () => {
  const { sub } = await subscription()
  const first = await encryptWebPushPayload(sub, encoder.encode('same'))
  const second = await encryptWebPushPayload(sub, encoder.encode('same'))
  assert(base64UrlEncode(first.slice(0, 86)) !== base64UrlEncode(second.slice(0, 86)), 'header reused across messages')
})

Deno.test('web push rejects payloads that exceed one record', async () => {
  const { sub, ua } = await subscription()
  const largest = await encryptWebPushPayload(sub, new Uint8Array(MAX_WEB_PUSH_PAYLOAD_BYTES).fill(0x61))
  assert(largest.length <= 4096, `body is ${largest.length} bytes`)
  assert((await decrypt(largest, ua)).length === MAX_WEB_PUSH_PAYLOAD_BYTES, 'largest payload lost bytes')
  let rejected = false
  try {
    await encryptWebPushPayload(sub, new Uint8Array(MAX_WEB_PUSH_PAYLOAD_BYTES + 1))
  } catch (error) {
    rejected = error instanceof RangeError
  }
  assert(rejected, 'oversized payload was not rejected')
})

Deno.test('VAPID header carries a verifiable ES256 token scoped to the push origin', async () => {
  const keys = await vapidKeys()
  const now = Date.UTC(2026, 8, 26, 12)
  const header = await vapidAuthorization(ENDPOINT, keys, now)
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)
  assert(match, `malformed header ${header}`)
  const [, token, publicKey] = match!
  assert(publicKey === keys.publicKey, 'k does not match the VAPID public key')

  const [encodedHeader, encodedClaims, signature] = token.split('.')
  const claims = JSON.parse(decoder.decode(base64UrlDecode(encodedClaims)))
  assert(claims.aud === 'https://web.push.apple.com', `aud was ${claims.aud}`)
  assert(claims.sub === keys.subject, 'sub claim missing')
  assert(claims.exp === Math.floor(now / 1000) + 12 * 3600, 'exp is not 12h out')
  assert(JSON.parse(decoder.decode(base64UrlDecode(encodedHeader))).alg === 'ES256', 'alg is not ES256')

  const verifyKey = await crypto.subtle.importKey('raw', base64UrlDecode(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    base64UrlDecode(signature),
    encoder.encode(`${encodedHeader}.${encodedClaims}`),
  )
  assert(valid, 'VAPID signature does not verify')
})

Deno.test('push endpoints are restricted to known push services', () => {
  for (const endpoint of [
    'https://web.push.apple.com/abc',
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ]) assert(isAllowedPushEndpoint(endpoint), `${endpoint} should be allowed`)

  for (const endpoint of [
    'http://web.push.apple.com/abc',
    'https://push.apple.com.evil.test/abc',
    'https://evilpush.apple.com/abc',
    'https://storage.googleapis.com/attacker-bucket/o',
    'https://169.254.169.254/latest',
    'https://user:pw@web.push.apple.com/abc',
    'https://web.push.apple.com:8443/abc',
    'not a url',
  ]) assert(!isAllowedPushEndpoint(endpoint), `${endpoint} should be rejected`)
})

Deno.test('subscription key validation rejects malformed keys', async () => {
  const { sub } = await subscription()
  assertSubscriptionKeys(sub)
  for (const bad of [
    { ...sub, p256dh: base64UrlEncode(new Uint8Array(33)) },
    { ...sub, auth: base64UrlEncode(new Uint8Array(8)) },
  ]) {
    let threw = false
    try { assertSubscriptionKeys(bad) } catch { threw = true }
    assert(threw, 'malformed keys accepted')
  }
})

Deno.test('sendWebPush maps push-service responses to outcomes', async () => {
  const keys = await vapidKeys()
  const { sub, ua } = await subscription()
  let captured: { url: string; init: RequestInit } | null = null
  const reply = (status: number) => async (url: string, init: RequestInit) => {
    captured = { url, init }
    return new Response(status === 201 ? null : 'detail', { status })
  }

  const sent = await sendWebPush(sub, { title: 'Hi' }, keys, { urgency: 'high', topic: 'trade' }, reply(201))
  assert(sent.outcome === 'sent', '201 was not treated as sent')
  const headers = captured!.init.headers as Record<string, string>
  assert(captured!.url === ENDPOINT, 'posted to the wrong URL')
  assert(headers['Content-Encoding'] === 'aes128gcm', 'content coding header missing')
  assert(headers.Urgency === 'high' && headers.Topic === 'trade', 'urgency/topic not forwarded')
  assert(headers.TTL === '86400', 'default TTL not applied')
  assert(JSON.parse(await decrypt(captured!.init.body as Uint8Array<ArrayBuffer>, ua)).title === 'Hi', 'body not decryptable')

  for (const status of [404, 410]) {
    assert((await sendWebPush(sub, {}, keys, {}, reply(status))).outcome === 'gone', `${status} not treated as gone`)
  }
  const throttled = await sendWebPush(sub, {}, keys, {}, reply(429))
  assert(throttled.outcome === 'failed' && throttled.retryable, '429 should be retryable')
  const unauthorized = await sendWebPush(sub, {}, keys, {}, reply(403))
  assert(unauthorized.outcome === 'failed' && !unauthorized.retryable, '403 should not be retryable')
  const network = await sendWebPush(sub, {}, keys, {}, async () => { throw new TypeError('reset') })
  assert(network.outcome === 'failed' && network.retryable, 'network errors should be retryable')

  let calls = 0
  const blocked = await sendWebPush({ ...sub, endpoint: 'https://internal.test/hook' }, {}, keys, {}, async () => {
    calls += 1
    return new Response(null, { status: 201 })
  })
  assert(blocked.outcome === 'failed' && calls === 0, 'non-push endpoint was contacted')
})
