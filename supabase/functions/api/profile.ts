import {
  booleanField,
  json,
  readJsonObject,
  requireUser,
  ServiceUnavailableError,
  stringField,
  throwDb,
  ValidationError,
} from '../_shared/apiRuntime.ts'
import { supabase } from '../_shared/supabase.ts'
import { pruneWebPushSubscriptions, webPushFanout, webPushVapidKeys } from '../_shared/notifications.ts'
import { assertSubscriptionKeys, isAllowedPushEndpoint } from '../_shared/webPush.ts'

const MAX_PUSH_TOKEN_LENGTH = 512
const REVOCATION_CREDENTIAL_RE = /^[A-Za-z0-9_-]{43}$/

function pushToken(body: Record<string, unknown>): string {
  const token = stringField(body, 'token').trim()
  if (token.length > MAX_PUSH_TOKEN_LENGTH) throw new ValidationError('token must contain at most 512 characters')
  return token
}

function revocationCredential(body: Record<string, unknown>): string {
  const credential = stringField(body, 'revocationCredential').trim()
  if (!REVOCATION_CREDENTIAL_RE.test(credential)) {
    throw new ValidationError('revocationCredential is invalid')
  }
  return credential
}

function createRevocationCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function credentialHash(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

type RpcError = { code?: string; message?: string }

function missingCredentialRpc(error: RpcError): boolean {
  return error.code === 'PGRST202'
}

async function clearPushTokenLegacy(userId: string, token: string): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ push_token: null })
    .eq('id', userId)
    .eq('push_token', token)
  if (error) throwDb(error)
}

async function updatePushToken(userId: string, token: string, active: boolean): Promise<string | null> {
  if (active) {
    const credential = createRevocationCredential()
    const { error } = await supabase.rpc('register_push_token_atomic', {
      p_user_id: userId,
      p_token: token,
      p_revocation_hash: await credentialHash(credential),
    })
    if (error) {
      if (!missingCredentialRpc(error)) throwDb(error)
      throw new ServiceUnavailableError('Push registration is temporarily unavailable. Please retry.')
    }
    return credential
  }

  const { error } = await supabase.rpc('clear_push_token_for_user_atomic', {
    p_user_id: userId,
    p_token: token,
  })
  if (error) {
    if (!missingCredentialRpc(error)) throwDb(error)
    await clearPushTokenLegacy(userId, token)
  }
  return null
}

async function revokePushToken(token: string, credential: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_push_token_atomic', {
    p_token: token,
    p_revocation_hash: await credentialHash(credential),
  })
  if (error && !missingCredentialRpc(error)) throwDb(error)
}

// Enough for a phone, tablet, and a few desktop browsers; older rows are dropped.
const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER = 10

function webPushEndpoint(body: Record<string, unknown>): string {
  const endpoint = stringField(body, 'endpoint').trim()
  if (endpoint.length > 2048 || !isAllowedPushEndpoint(endpoint)) {
    throw new ValidationError('endpoint is not a supported push service')
  }
  return endpoint
}

function webPushKey(body: Record<string, unknown>, key: 'p256dh' | 'auth'): string {
  // Browsers emit unpadded base64url; normalise stray padding before validation.
  return stringField(body, key).trim().replace(/=+$/g, '')
}

function webPushGeneration(body: Record<string, unknown>): number {
  const generation = body.generation
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
    throw new ValidationError('generation must be a non-negative safe integer')
  }
  return generation
}

async function subscribeWebPush(userId: string, body: Record<string, unknown>) {
  const subscription = {
    endpoint: webPushEndpoint(body),
    p256dh: webPushKey(body, 'p256dh'),
    auth: webPushKey(body, 'auth'),
  }
  try {
    assertSubscriptionKeys(subscription)
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : 'subscription keys are invalid')
  }
  const generation = webPushGeneration(body)
  const previous = revocationCredential(body)
  const credential = createRevocationCredential()
  const { data, error } = await supabase.rpc('register_web_push_atomic', {
    p_user_id: userId,
    p_endpoint: subscription.endpoint,
    p_p256dh: subscription.p256dh,
    p_auth: subscription.auth,
    p_expected_generation: generation,
    p_credential_hash: await credentialHash(previous),
    p_next_credential_hash: await credentialHash(credential),
  })
  if (error) {
    if (!missingCredentialRpc(error)) throwDb(error)
    throw new ServiceUnavailableError('Web push registration is temporarily unavailable. Please retry.')
  }
  const result = data?.[0]
  if (!result?.applied) return { applied: false as const }

  const { data: stale, error: staleError } = await supabase
    .from('web_push_subscriptions')
    .select('endpoint, user_id, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .order('endpoint')
    .range(MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER, MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER + 50)
  // Registration is committed. Preserve its acknowledgement even if quota cleanup needs a later retry.
  if (staleError) console.error('Web push quota lookup failed', staleError)
  else if (stale?.length) {
    const { error: pruneError } = await pruneWebPushSubscriptions(stale)
    if (pruneError) console.error('Web push quota cleanup failed', pruneError)
  }
  return { applied: true as const, generation: result.generation, revocationCredential: credential }
}

async function unsubscribeWebPush(userId: string, endpoint: string) {
  const credential = createRevocationCredential()
  const { data, error } = await supabase.rpc('clear_web_push_for_user_atomic', {
    p_user_id: userId,
    p_endpoint: endpoint,
    p_next_credential_hash: await credentialHash(credential),
  })
  if (error) {
    if (!missingCredentialRpc(error)) throwDb(error)
    throw new ServiceUnavailableError('Web push cleanup is temporarily unavailable. Please retry.')
  }
  const result = data?.[0]
  return result?.applied
    ? { applied: true as const, generation: result.generation, revocationCredential: credential }
    : { applied: false as const }
}

async function handleWebPushRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST') return null
  if (path === '/profile/web-push/config') {
    return json({ ok: true, publicKey: webPushVapidKeys()?.publicKey ?? null })
  }
  if (path === '/profile/web-push/subscribe') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    if (!webPushVapidKeys()) throw new ServiceUnavailableError('Web push is not configured.')
    const result = await subscribeWebPush(userId, body)
    if (!result.applied) {
      return json({ ok: false, code: 'WEB_PUSH_STALE', error: 'Notification registration changed. Enable notifications again.' }, 409)
    }
    return json({ ok: true, ...result })
  }
  if (path === '/profile/web-push/unsubscribe') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    const result = await unsubscribeWebPush(userId, webPushEndpoint(body))
    return json({ ok: true, ...result })
  }
  if (path === '/profile/web-push/test') {
    const userId = await requireUser(req)
    if (!webPushVapidKeys()) throw new ServiceUnavailableError('Web push is not configured.')
    const summary = await webPushFanout([{
      userId,
      title: 'Pancake',
      body: 'Notifications are working on this device. 🥞',
      category: 'activity',
    }])
    return json({ ok: true, ...summary })
  }
  return null
}

export async function handleProfileRoute(req: Request, path: string): Promise<Response | null> {
  if (path.startsWith('/profile/web-push/')) return handleWebPushRoute(req, path)
  if (req.method !== 'POST') return null
  if (path === '/profile/push-token/revoke') {
    const body = await readJsonObject(req)
    await revokePushToken(pushToken(body), revocationCredential(body))
    return json({ ok: true })
  }
  if (path !== '/profile/push-token') return null
  const body = await readJsonObject(req)
  const userId = await requireUser(req)
  const credential = await updatePushToken(userId, pushToken(body), booleanField(body, 'active'))
  return json({ ok: true, ...(credential ? { revocationCredential: credential } : {}) })
}
