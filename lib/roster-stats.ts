import { supabase } from '@/lib/supabase'
import { currentSeasonYear } from '@/lib/shared/season'

export type RosterAverage = {
    avg_points: number | null
    avg_rebounds: number | null
    avg_assists: number | null
    avg_steals: number | null
    avg_blocks: number | null
    avg_three_pointers_made: number | null
    avg_turnovers: number | null
    avg_minutes_played: number | null
    games_played: number | null
}

export type RosterStatsMaps = {
    avgMap: Map<string, number>
    avgStatsMap: Map<string, RosterAverage>
}

export const EMPTY_AVG_MAP = new Map<string, number>()
export const EMPTY_STATS_MAP = new Map<string, RosterAverage>()

const uniqueIds = (ids: string[]) => Array.from(new Set(ids.filter(Boolean)))

export async function getRosterStatsMaps(
    playerIds: string[],
    leagueId: string,
    seasonYear = currentSeasonYear(),
): Promise<RosterStatsMaps> {
    const ids = uniqueIds(playerIds)
    const avgMap = new Map<string, number>()
    const avgStatsMap = new Map<string, RosterAverage>()
    if (ids.length === 0) return { avgMap, avgStatsMap }

    const [avgResult, statsResult] = await Promise.all([
        supabase
            .from('v_player_avg_fantasy_points')
            .select('player_id, avg_fantasy_points')
            .eq('league_id', leagueId)
            .eq('season_year', seasonYear)
            .in('player_id', ids),
        supabase
            .from('mv_player_season_averages')
            .select('player_id, avg_points, avg_rebounds, avg_assists, avg_steals, avg_blocks, avg_three_pointers_made, avg_turnovers, avg_minutes_played, games_played')
            .eq('season_year', seasonYear)
            .in('player_id', ids),
    ])

    if (avgResult.error) throw avgResult.error
    if (statsResult.error) throw statsResult.error

    for (const row of (avgResult.data ?? []) as { player_id: string | null; avg_fantasy_points: number | null }[]) {
        if (row.player_id && row.avg_fantasy_points != null) {
            avgMap.set(row.player_id, Number(row.avg_fantasy_points))
        }
    }
    for (const row of (statsResult.data ?? []) as (RosterAverage & { player_id: string | null })[]) {
        if (row.player_id) avgStatsMap.set(row.player_id, row)
    }

    return { avgMap, avgStatsMap }
}

