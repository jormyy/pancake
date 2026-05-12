import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { Database } from './database.ts'

export const supabase = createClient<Database>(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)
