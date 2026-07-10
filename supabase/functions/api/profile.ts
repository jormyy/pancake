import {
  booleanField,
  json,
  readJsonObject,
  requireUser,
  stringField,
  throwDb,
  ValidationError,
} from '../_shared/apiRuntime.ts'
import { supabase } from '../_shared/supabase.ts'

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

async function updatePushToken(userId: string, token: string, active: boolean): Promise<string | null> {
  if (active) {
    const credential = createRevocationCredential()
    const { error } = await supabase.rpc('register_push_token_atomic', {
      p_user_id: userId,
      p_token: token,
      p_revocation_hash: await credentialHash(credential),
    })
    if (error) throwDb(error)
    return credential
  }

  const { error } = await supabase.rpc('clear_push_token_for_user_atomic', {
    p_user_id: userId,
    p_token: token,
  })
  if (error) throwDb(error)
  return null
}

async function revokePushToken(token: string, credential: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_push_token_atomic', {
    p_token: token,
    p_revocation_hash: await credentialHash(credential),
  })
  if (error) throwDb(error)
}

export async function handleProfileRoute(req: Request, path: string): Promise<Response | null> {
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
