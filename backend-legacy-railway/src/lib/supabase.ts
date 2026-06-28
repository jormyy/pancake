import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { getSupabaseAdminKeyMode } from './supabaseKeyMode'

const supabaseUrl = process.env.SUPABASE_URL!
const adminKey = process.env.PANCAKE_SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SECRET_KEY

if (!adminKey) {
    throw new Error('Missing PANCAKE_SUPABASE_SECRET_KEY or SUPABASE_SECRET_KEY')
}
if (getSupabaseAdminKeyMode() !== 'modern-secret') {
    throw new Error('PANCAKE_SUPABASE_SECRET_KEY or SUPABASE_SECRET_KEY must be an sb_secret_ key')
}

// Admin client: use Supabase secret keys only; legacy service-role JWTs are not accepted.
export const supabase = createClient<Database>(supabaseUrl, adminKey, {
    auth: { persistSession: false },
})

// Fetches all rows from a table in 1000-row pages, bypassing PostgREST max_rows cap.
export async function fetchAllPlayers(): Promise<{ id: string; display_name: string; nba_id: string | null }[]> {
    const PAGE = 1000
    const all: { id: string; display_name: string; nba_id: string | null }[] = []
    let from = 0
    while (true) {
        const { data, error } = await supabase
            .from('players')
            .select('id, display_name, nba_id')
            .range(from, from + PAGE - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        all.push(...data.map((p) => ({ ...p, display_name: p.display_name ?? '' })))
        if (data.length < PAGE) break
        from += PAGE
    }
    return all
}
