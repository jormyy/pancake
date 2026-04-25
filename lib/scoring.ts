import { supabase } from '@/lib/supabase'
import { getCurrentSeason } from '@/lib/shared/season'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { LiveStatLine } from '@/lib/games'

/**
 * SYNC: Keep formula identical to backend/src/lib/scoring.ts calculateFantasyPoints.
 * This frontend version operates on camelCase LiveStatLine from lib/games.ts.
 */
export function computeLiveFantasyPoints(
    stats: LiveStatLine,
    settings: Record<string, number>,
): number {
    if (stats.didNotPlay) return 0
    return parseFloat((
        stats.points             * (settings.points                  ?? 0) +
        stats.rebounds           * (settings.rebounds                ?? 0) +
        stats.assists            * (settings.assists                 ?? 0) +
        stats.steals             * (settings.steals                  ?? 0) +
        stats.blocks             * (settings.blocks                  ?? 0) +
        (stats.turnovers ?? 0)   * (settings.turnovers               ?? 0) +
        stats.threeMade          * (settings.three_pointers_made     ?? 0) +
        stats.fgMade             * (settings.field_goals_made        ?? 0) +
        stats.fgAttempted        * (settings.field_goals_attempted   ?? 0) +
        stats.ftMade             * (settings.free_throws_made        ?? 0) +
        stats.ftAttempted        * (settings.free_throws_attempted   ?? 0) +
        (stats.doubleDouble ? (settings.double_double ?? 0) : 0) +
        (stats.tripleDouble ? (settings.triple_double ?? 0) : 0)
    ).toFixed(2))
}

export type Matchup = {
    id: string
    weekNumber: number
    myPoints: number | null
    opponentPoints: number | null
    myTeamName: string
    opponentTeamName: string
    myUsername: string
    opponentUsername: string
    myWins: number
    myLosses: number
    opponentWins: number
    opponentLosses: number
    isFinalized: boolean
    iWon: boolean | null
    myMemberId: string
    opponentMemberId: string
    seasonId: string
    seasonYear: number
}

export type StandingRow = {
    memberId: string
    teamName: string
    wins: number
    losses: number
    pointsFor: number
    pointsAgainst: number
    maxPointsFor: number
}

export async function getMyMatchup(memberId: string, leagueId: string): Promise<Matchup | null> {
    const season = await getCurrentSeason(leagueId)
    if (!season) return null

    const weekNumber = await getCurrentWeekNumber(season.seasonYear)
    if (!weekNumber) return null

    const { data, error } = await supabase
        .from('matchups')
        .select(
            'id, week_number, home_points, away_points, winner_member_id, is_finalized, home_member_id, away_member_id',
        )
        .eq('league_id', leagueId)
        .eq('league_season_id', season.id)
        .eq('week_number', weekNumber)
        .or(`home_member_id.eq.${memberId},away_member_id.eq.${memberId}`)
        .maybeSingle()

    if (error) throw error
    if (!data) return null

    // Fetch both members' team names + usernames
    const opponentId = data.home_member_id === memberId ? data.away_member_id : data.home_member_id
    const [{ data: members }, { data: allMatchups }] = await Promise.all([
        supabase
            .from('league_members')
            .select('id, team_name, profiles(display_name)')
            .in('id', [memberId, opponentId]),
        supabase
            .from('matchups')
            .select('home_member_id, away_member_id, winner_member_id')
            .eq('league_id', leagueId)
            .eq('league_season_id', season.id)
            .eq('is_finalized', true)
            .or(`home_member_id.in.(${memberId},${opponentId}),away_member_id.in.(${memberId},${opponentId})`),
    ])

    const memberMap = Object.fromEntries(
        (members ?? []).map((m) => {
            const profile = m.profiles as { display_name?: string | null } | null
            return [m.id, { teamName: m.team_name, username: profile?.display_name ?? '' }]
        })
    )

    // Compute records from finalized matchups
    const records: Record<string, { wins: number; losses: number }> = {
        [memberId]: { wins: 0, losses: 0 },
        [opponentId]: { wins: 0, losses: 0 },
    }
    for (const m of allMatchups ?? []) {
        if (!m.winner_member_id) continue
        const loserId = m.winner_member_id === m.home_member_id ? m.away_member_id : m.home_member_id
        if (records[m.winner_member_id]) records[m.winner_member_id].wins++
        if (records[loserId]) records[loserId].losses++
    }

    const isHome = data.home_member_id === memberId

    return {
        id: data.id,
        weekNumber: data.week_number,
        myPoints: isHome ? data.home_points : data.away_points,
        opponentPoints: isHome ? data.away_points : data.home_points,
        myTeamName: memberMap[memberId]?.teamName ?? 'My Team',
        opponentTeamName: memberMap[opponentId]?.teamName ?? 'Opponent',
        myUsername: memberMap[memberId]?.username ?? '',
        opponentUsername: memberMap[opponentId]?.username ?? '',
        myWins: records[memberId].wins,
        myLosses: records[memberId].losses,
        opponentWins: records[opponentId].wins,
        opponentLosses: records[opponentId].losses,
        isFinalized: data.is_finalized,
        iWon: data.winner_member_id != null ? data.winner_member_id === memberId : null,
        myMemberId: memberId,
        opponentMemberId: opponentId,
        seasonId: season.id,
        seasonYear: season.seasonYear,
    }
}

export async function getLeagueStandings(leagueId: string): Promise<StandingRow[]> {
    const season = await getCurrentSeason(leagueId)
    if (!season) return []

    const [{ data: members }, { data: matchups }] = await Promise.all([
        supabase.from('league_members').select('id, team_name').eq('league_id', leagueId),
        supabase
            .from('matchups')
            .select(
                'home_member_id, away_member_id, home_points, away_points, winner_member_id, is_finalized',
            )
            .eq('league_id', leagueId)
            .eq('league_season_id', season.id),
    ])

    const teamNames = Object.fromEntries((members ?? []).map((m) => [m.id, m.team_name]))

    const map: Record<string, StandingRow> = {}
    for (const m of members ?? []) {
        map[m.id] = {
            memberId: m.id,
            teamName: m.team_name ?? 'Team',
            wins: 0,
            losses: 0,
            pointsFor: 0,
            pointsAgainst: 0,
            maxPointsFor: 0,
        }
    }

    for (const m of matchups ?? []) {
        if (m.is_finalized) {
            const hp = Number(m.home_points ?? 0)
            const ap = Number(m.away_points ?? 0)

            if (map[m.home_member_id]) {
                map[m.home_member_id].pointsFor += hp
                map[m.home_member_id].pointsAgainst += ap
                if (hp > map[m.home_member_id].maxPointsFor) map[m.home_member_id].maxPointsFor = hp
            }
            if (map[m.away_member_id]) {
                map[m.away_member_id].pointsFor += ap
                map[m.away_member_id].pointsAgainst += hp
                if (ap > map[m.away_member_id].maxPointsFor) map[m.away_member_id].maxPointsFor = ap
            }
        }

        if (m.is_finalized && m.winner_member_id) {
            const loserId =
                m.winner_member_id === m.home_member_id ? m.away_member_id : m.home_member_id
            if (map[m.winner_member_id]) map[m.winner_member_id].wins++
            if (map[loserId]) map[loserId].losses++
        }
    }

    return Object.values(map).sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor)
}
