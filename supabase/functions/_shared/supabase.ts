import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
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

export const supabase = createClient<Database>(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY') ??
    Deno.env.get('SUPABASE_SECRET_KEY') ??
    defaultSecretKey() ??
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)
