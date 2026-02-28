import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Service role client — bypasses RLS, backend use only
export const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
})
