import { createClient } from 'npm:@supabase/supabase-js@2'
import type { Database } from './database.ts'

function defaultSecretKey(): string | undefined {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (!raw) return undefined

  try {
    const keys = JSON.parse(raw) as Record<string, string | undefined>
    return keys.default
  } catch {
    return undefined
  }
}

export function requiredSecretKey(): string {
  const key =
    Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY') ??
    Deno.env.get('SUPABASE_SECRET_KEY') ??
    defaultSecretKey()

  if (!key) throw new Error('Missing Supabase secret key')
  return key
}

export const supabase = createClient<Database>(
  Deno.env.get('SUPABASE_URL')!,
  requiredSecretKey(),
  { auth: { persistSession: false } },
)
