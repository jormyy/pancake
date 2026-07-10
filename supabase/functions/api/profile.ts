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

function pushToken(body: Record<string, unknown>): string {
  const token = stringField(body, 'token').trim()
  if (token.length > MAX_PUSH_TOKEN_LENGTH) throw new ValidationError('token must contain at most 512 characters')
  return token
}

async function updatePushToken(userId: string, token: string, active: boolean): Promise<void> {
  if (active) {
    const { error: clearError } = await supabase
      .from('profiles')
      .update({ push_token: null })
      .eq('push_token', token)
      .neq('id', userId)
    if (clearError) throwDb(clearError)

    const { error: setError } = await supabase
      .from('profiles')
      .update({ push_token: token })
      .eq('id', userId)
    if (setError) throwDb(setError)
    return
  }

  const { error } = await supabase
    .from('profiles')
    .update({ push_token: null })
    .eq('id', userId)
    .eq('push_token', token)
  if (error) throwDb(error)
}

export async function handleProfileRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST' || path !== '/profile/push-token') return null
  const body = await readJsonObject(req)
  const userId = await requireUser(req)
  await updatePushToken(userId, pushToken(body), booleanField(body, 'active'))
  return json({ ok: true })
}
