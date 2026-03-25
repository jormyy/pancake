import { supabase } from '@/lib/supabase'

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
    const { data: season } = await supabase
        .from('league_seasons')
        .select('id')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()

    if (!season) return { semifinals: [], final: null, champion: null }

    const { data: rows, error } = await supabase
        .from('matchups')
        .select(
            'id, week_number, matchup_type, home_member_id, away_member_id, home_points, away_points, winner_member_id, is_finalized',
        )
        .eq('league_id', leagueId)
        .eq('league_season_id', (season as any).id)
        .in('matchup_type', ['playoff_semifinal', 'playoff_final'])
        .order('week_number', { ascending: true })

    if (error) throw error
    if (!rows || rows.length === 0) return { semifinals: [], final: null, champion: null }

    // Collect all member IDs and fetch team names
    const memberIds = new Set<string>()
    for (const r of rows as any[]) {
        memberIds.add(r.home_member_id)
        memberIds.add(r.away_member_id)
    }

    const { data: members } = await supabase
        .from('league_members')
        .select('id, team_name')
        .in('id', Array.from(memberIds))

    const nameMap = Object.fromEntries((members ?? []).map((m) => [m.id, m.team_name ?? 'Unknown']))

    const toMatchup = (r: any, round: 'semifinal' | 'final'): BracketMatchup => ({
        id: r.id,
        round,
        weekNumber: r.week_number,
        homeId: r.home_member_id,
        homeName: nameMap[r.home_member_id] ?? 'TBD',
        homePoints: r.home_points != null ? Number(r.home_points) : null,
        awayId: r.away_member_id,
        awayName: nameMap[r.away_member_id] ?? 'TBD',
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
        champion = nameMap[final.winnerId] ?? null
    }

    return { semifinals: semis, final, champion }
}
