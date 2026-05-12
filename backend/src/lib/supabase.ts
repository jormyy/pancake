import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

const supabaseUrl = process.env.SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Service role client — bypasses RLS, backend use only
export const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
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
