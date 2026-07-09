import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

type RealtimeEvent = '*' | 'INSERT' | 'UPDATE' | 'DELETE'

export type TableChangeWatch = {
    table: string
    filter?: string
    event?: RealtimeEvent
    onChange?: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void
}

export function scopeWatchesToLeague(leagueId: string, watches: TableChangeWatch[]): TableChangeWatch[] {
    return watches.map((watch) => ({ ...watch, filter: `league_id=eq.${leagueId}` }))
}
