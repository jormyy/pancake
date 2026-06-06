import { supabase } from '@/lib/supabase'
import { getCurrentSeasonId } from '@/lib/shared/season'

export type BracketRound = 'quarterfinal' | 'semifinal' | 'final'

export type BracketMatchup = {
    id: string
    round: BracketRound
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
    quarterfinals: BracketMatchup[]
    semifinals: BracketMatchup[]
    final: BracketMatchup | null
    champion: string | null
}

const ROUND_BY_TYPE: Record<string, BracketRound> = {
    playoff_quarterfinal: 'quarterfinal',
    playoff_semifinal: 'semifinal',
    playoff_final: 'final',
}

export async function getPlayoffBracket(leagueId: string): Promise<PlayoffBracket> {
    const seasonId = await getCurrentSeasonId(leagueId)

    if (!seasonId) return { quarterfinals: [], semifinals: [], final: null, champion: null }

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
        .in('matchup_type', ['playoff_quarterfinal', 'playoff_semifinal', 'playoff_final'])
        .order('week_number', { ascending: true })

    if (error) throw error
    if (!rows || rows.length === 0)
        return { quarterfinals: [], semifinals: [], final: null, champion: null }

    type MemberRef = { id: string; team_name: string } | null
    type Row = (typeof rows)[number] & { home: MemberRef; away: MemberRef; winner: MemberRef }

    const toMatchup = (r: Row, round: BracketRound): BracketMatchup => ({
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

    const typed = rows as Row[]

    const quarterfinals = typed
        .filter((r) => r.matchup_type === 'playoff_quarterfinal')
        .map((r) => toMatchup(r, ROUND_BY_TYPE.playoff_quarterfinal))

    const semis = typed
        .filter((r) => r.matchup_type === 'playoff_semifinal')
        .map((r) => toMatchup(r, ROUND_BY_TYPE.playoff_semifinal))

    const finalRow = typed.find((r) => r.matchup_type === 'playoff_final')
    const final = finalRow ? toMatchup(finalRow, ROUND_BY_TYPE.playoff_final) : null

    let champion: string | null = null
    if (final?.isFinalized && final.winnerId) {
        champion = finalRow?.winner?.team_name ?? null
    }

    return { quarterfinals, semifinals: semis, final, champion }
}
