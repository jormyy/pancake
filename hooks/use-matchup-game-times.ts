import { useEffect, useState } from 'react'
import type { NBAGameRow } from '@/lib/games'
import { DEFAULT_LEAGUE_TIMEZONE } from '@/lib/timezone'
import { supabase } from '@/lib/supabase'

export function useMatchupGameTimes(games: readonly NBAGameRow[], leagueId?: string, revision?: string | number | null) {
    const key = JSON.stringify([leagueId, games.map(game => game.id).sort()])
    const [loaded, setLoaded] = useState<{ key: string; values: Map<string, string | null>; timezone: string } | null>(null)
    useEffect(() => {
        const [league, ids] = JSON.parse(key) as [string | null, string[]]
        if (!ids.length) return
        let active = true
        void Promise.all([
            supabase.from('nba_games').select('id,game_time').in('id', ids),
            league ? supabase.from('leagues').select('timezone').eq('id', league).maybeSingle() : Promise.resolve({ data: null }),
        ]).then(([games, league]) => {
            if (active && !games.error) setLoaded({ key, values: new Map((games.data ?? []).map(game => [game.id, game.game_time])), timezone: league.data?.timezone ?? DEFAULT_LEAGUE_TIMEZONE })
        }, () => {})
        return () => { active = false }
    }, [key, revision])
    return loaded?.key === key ? loaded : null
}
