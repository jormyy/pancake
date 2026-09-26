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

async function subscribeWebPush(userId: string, body: Record<string, unknown>): Promise<void> {
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

  // An endpoint belongs to one browser profile; re-subscribing after a
  // different user signs in on the same device moves it to that user.
  const { error } = await supabase
    .from('web_push_subscriptions')
    .upsert({ user_id: userId, ...subscription, updated_at: new Date().toISOString() }, { onConflict: 'endpoint' })
  if (error) throwDb(error)

  const { data: stale, error: staleError } = await supabase
    .from('web_push_subscriptions')
    .select('endpoint')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .range(MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER, MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER + 50)
  if (staleError) throwDb(staleError)
  if (stale && stale.length > 0) {
    const { error: pruneError } = await pruneWebPushSubscriptions(stale.map((row) => row.endpoint))
    if (pruneError) throwDb(pruneError)
  }
}

async function unsubscribeWebPush(userId: string, endpoint: string): Promise<void> {
  const { error } = await supabase
    .from('web_push_subscriptions')
    .delete()
    .eq('user_id', userId)
    .eq('endpoint', endpoint)
  if (error) throwDb(error)
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
    await subscribeWebPush(userId, body)
    return json({ ok: true })
  }
  if (path === '/profile/web-push/unsubscribe') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    await unsubscribeWebPush(userId, stringField(body, 'endpoint').trim())
    return json({ ok: true })
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
