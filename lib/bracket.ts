import { supabase } from '@/lib/supabase'
import { getCurrentSeasonId } from '@/lib/shared/season'

export type BracketMatchup = {
    id: string
    round: 'semifinal' | 'final'
    weekNumber: number
    homeId: string
    homeName: string
    homePoints: number | null
    awayId: string
    awayName: string
    awayPoints: number | null
    winnerId: string | null
    isFinalized: boolean
}

export type PlayoffBracket = {
    semifinals: BracketMatchup[]
    final: BracketMatchup | null
    champion: string | null
}

export async function getPlayoffBracket(leagueId: string): Promise<PlayoffBracket> {
    const seasonId = await getCurrentSeasonId(leagueId)

    if (!seasonId) return { semifinals: [], final: null, champion: null }

    const { data: rows, error } = await supabase
        .from('matchups')
        .select(
            `
            id, week_number, matchup_type, home_member_id, away_member_id, home_points, away_points, winner_member_id, is_finalized,
            home:league_members!matchups_home_member_id_fkey(id, team_name),
            away:league_members!matchups_away_member_id_fkey(id, team_name),
            winner:league_members!matchups_winner_member_id_fkey(id, team_name)
            `,
        )
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .in('matchup_type', ['playoff_semifinal', 'playoff_final'])
        .order('week_number', { ascending: true })

    if (error) throw error
    if (!rows || rows.length === 0) return { semifinals: [], final: null, champion: null }

    const toMatchup = (r: any, round: 'semifinal' | 'final'): BracketMatchup => ({
        id: r.id,
        round,
        weekNumber: r.week_number,
        homeId: r.home_member_id,
        homeName: r.home?.team_name ?? 'TBD',
        homePoints: r.home_points != null ? Number(r.home_points) : null,
        awayId: r.away_member_id,
        awayName: r.away?.team_name ?? 'TBD',
        awayPoints: r.away_points != null ? Number(r.away_points) : null,
        winnerId: r.winner_member_id ?? null,
        isFinalized: r.is_finalized,
    })

    const semis = (rows as any[])
        .filter((r) => r.matchup_type === 'playoff_semifinal')
        .map((r) => toMatchup(r, 'semifinal'))

    const finalRow = (rows as any[]).find((r) => r.matchup_type === 'playoff_final')
    const final = finalRow ? toMatchup(finalRow, 'final') : null

    let champion: string | null = null
    if (final?.isFinalized && final.winnerId) {
        champion = finalRow?.winner?.team_name ?? null
    }

    return { semifinals: semis, final, champion }
}
