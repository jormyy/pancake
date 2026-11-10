import { supabase } from '@/lib/supabase'
import type { RosterPlayer } from '@/lib/roster'

export async function getTradePlayerValues(playerIds: string[]): Promise<Map<string, number | null>> {
    const ids = [...new Set(playerIds)]
    if (ids.length === 0) return new Map()
    try {
        const { data, error } = await supabase.from('dynasty_rankings')
            .select('player_id, trade_value')
            .eq('source', 'onenumberhoops.com')
            .in('player_id', ids)
            .order('fetched_at', { ascending: false })
            .order('source_rank', { ascending: true })
        if (error) throw error
        const values = new Map<string, number | null>()
        for (const row of data ?? []) {
            if (row.player_id && !values.has(row.player_id)) values.set(row.player_id, row.trade_value)
        }
        return values
    } catch (error) {
        console.warn('Could not load optional trade player values.', error)
        return new Map()
    }
}

export async function withTradeRosterValues(rosters: Record<string, RosterPlayer[]>): Promise<Record<string, RosterPlayer[]>> {
    const values = await getTradePlayerValues(Object.values(rosters).flatMap(roster => roster.map(player => player.players.id)))
    return Object.fromEntries(Object.entries(rosters).map(([memberId, roster]) => [memberId,
        roster.map(player => ({ ...player, tradeValue: values.get(player.players.id) ?? null })),
    ]))
}
