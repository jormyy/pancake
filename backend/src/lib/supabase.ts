import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

console.log('[supabase] URL:', supabaseUrl?.slice(0, 40))

function fetchWithTimeout(url: string | URL, options?: RequestInit) {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 8_000)
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(t))
}

// Service role client — bypasses RLS, backend use only
export const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    global: { fetch: fetchWithTimeout as typeof fetch },
})
