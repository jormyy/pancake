import { assertReadActive } from '@/lib/shared/read-admission'
import { supabase } from '@/lib/supabase'
import { getCurrentSeason } from '@/lib/shared/season'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { LiveStatLine } from '@/lib/games'
import { calculateFantasyPoints } from '@pancake/core'
import type { StatLine, ScoringSettings } from '@pancake/core'

function liveStatToLine(stats: LiveStatLine): StatLine {
    return {
        points: stats.points,
        rebounds: stats.rebounds,
        assists: stats.assists,
        steals: stats.steals,
        blocks: stats.blocks,
        turnovers: stats.turnovers ?? 0,
        threePointersMade: stats.threeMade,
        fieldGoalsMade: stats.fgMade,
        fieldGoalsAttempted: stats.fgAttempted,
        freeThrowsMade: stats.ftMade,
        freeThrowsAttempted: stats.ftAttempted,
        doubleDouble: stats.doubleDouble,
        tripleDouble: stats.tripleDouble,
        didNotPlay: stats.didNotPlay,
    }
}

export function computeLiveFantasyPoints(
    stats: LiveStatLine,
    settings: Record<string, number>,
): number {
    return calculateFantasyPoints(liveStatToLine(stats), settings as ScoringSettings)
}

export type Matchup = {
    id: string
    weekNumber: number
    roundStartWeek?: number
    roundEndWeek?: number
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
    ties: number
    pointsFor: number
    pointsAgainst: number
    maxPointsFor: number
}

export function compareStandingsRows(a: StandingRow, b: StandingRow): number {
    const aGames = Math.max(a.wins + a.losses + a.ties, 1)
    const bGames = Math.max(b.wins + b.losses + b.ties, 1)
    return (b.wins + 0.5 * b.ties) / bGames - (a.wins + 0.5 * a.ties) / aGames ||
        b.pointsFor / bGames - a.pointsFor / aGames ||
        b.maxPointsFor - a.maxPointsFor ||
        a.pointsAgainst - b.pointsAgainst ||
        a.teamName.localeCompare(b.teamName) ||
        a.memberId.localeCompare(b.memberId)
}

type LeagueStandingsMember = {
    id: string
    team_name: string | null
}

function createInitialStandingsRows(members: LeagueStandingsMember[] | null | undefined): Record<string, StandingRow> {
    const map: Record<string, StandingRow> = {}
    for (const m of members ?? []) {
        map[m.id] = {
            memberId: m.id,
            teamName: m.team_name ?? 'Team',
            wins: 0,
            losses: 0,
            ties: 0,
            pointsFor: 0,
            pointsAgainst: 0,
            maxPointsFor: 0,
        }
    }
    return map
}

export type LeagueWeekMatchup = {
    id: string
    homeMemberId: string
    awayMemberId: string
    homeTeamName: string
    awayTeamName: string
    homePoints: number | null
    awayPoints: number | null
    isFinalized: boolean
    isMine: boolean
}

export type MatchupContext = Pick<Matchup, 'id' | 'seasonId' | 'seasonYear' | 'weekNumber' | 'myMemberId' | 'opponentMemberId'>

export async function getMyMatchup(memberId: string, leagueId: string, onContext?: (context: MatchupContext) => void): Promise<Matchup | null> {
    const season = await getCurrentSeason(leagueId)
    if (!season) return null

    const weekNumber = await getCurrentWeekNumber(season.seasonYear)
    if (!weekNumber) return null

    const { data, error } = await supabase
        .from('matchups')
        .select(
            'id, week_number, end_week_number, home_points, away_points, winner_member_id, is_finalized, home_member_id, away_member_id',
        )
        .eq('league_id', leagueId)
        .eq('league_season_id', season.id)
        .eq('is_voided', false)
        .lte('week_number', weekNumber)
        .or(`and(home_member_id.eq.${memberId},or(end_week_number.gte.${weekNumber},week_number.eq.${weekNumber})),and(away_member_id.eq.${memberId},or(end_week_number.gte.${weekNumber},week_number.eq.${weekNumber}))`)
        .maybeSingle()

    if (error) throw error
    if (!data) return null

    // Fetch both members' team names + usernames
    const opponentId = data.home_member_id === memberId ? data.away_member_id : data.home_member_id
    onContext?.({ id: data.id, seasonId: season.id, seasonYear: season.seasonYear, weekNumber, myMemberId: memberId, opponentMemberId: opponentId })
    const [{ data: members, error: membersError }, { data: allMatchups, error: recordsError }] = await Promise.all([
        supabase
            .from('league_members')
            .select('id, team_name, profiles(display_name)')
            .in('id', [memberId, opponentId]),
        supabase
            .from('matchups')
            .select('home_member_id, away_member_id, winner_member_id')
            .eq('league_id', leagueId)
            .eq('league_season_id', season.id)
            .eq('is_voided', false)
            .eq('is_finalized', true)
            // Records (wins/losses) shown alongside the current matchup must
            // count regular-season games only; playoff outcomes don't change
            // a team's season W/L line.
            .eq('matchup_type', 'regular_season')
            .or(`home_member_id.in.(${memberId},${opponentId}),away_member_id.in.(${memberId},${opponentId})`),
    ])

    if (membersError) throw membersError
    if (recordsError) throw recordsError

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
        weekNumber,
        roundStartWeek: data.week_number,
        roundEndWeek: data.end_week_number ?? data.week_number,
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

export async function getLeagueStandings(leagueId: string, canRead?: () => boolean): Promise<StandingRow[]> {
    assertReadActive(canRead)
    const season = await getCurrentSeason(leagueId)
    assertReadActive(canRead)
    if (!season) {
        const { data: members, error } = await supabase
            .from('league_members')
            .select('id, team_name')
            .eq('league_id', leagueId)

        if (error) throw error
        return Object.values(createInitialStandingsRows(members)).sort(compareStandingsRows)
    }

    const [{ data: members, error: membersError }, { data: matchups, error: matchupsError }] = await Promise.all([
        supabase.from('league_members').select('id, team_name').eq('league_id', leagueId),
        supabase
            .from('matchups')
            .select(
                'home_member_id, away_member_id, home_points, away_points, home_max_possible_points, away_max_possible_points, winner_member_id, is_finalized',
            )
            .eq('league_id', leagueId)
            .eq('league_season_id', season.id)
            .eq('is_voided', false)
            // League standings reflect regular-season records only; playoff
            // matchups have their own bracket display and must not inflate
            // wins/losses/PF/PA totals.
            .eq('matchup_type', 'regular_season'),
    ])

    if (membersError) throw membersError
    if (matchupsError) throw matchupsError

    const map = createInitialStandingsRows(members)

    for (const m of matchups ?? []) {
        if (m.is_finalized) {
            const hp = Number(m.home_points ?? 0)
            const ap = Number(m.away_points ?? 0)
            const hMax = Number(m.home_max_possible_points ?? 0)
            const aMax = Number(m.away_max_possible_points ?? 0)

            if (map[m.home_member_id]) {
                map[m.home_member_id].pointsFor += hp
                map[m.home_member_id].pointsAgainst += ap
                map[m.home_member_id].maxPointsFor += hMax
            }
            if (map[m.away_member_id]) {
                map[m.away_member_id].pointsFor += ap
                map[m.away_member_id].pointsAgainst += hp
                map[m.away_member_id].maxPointsFor += aMax
            }
        }

        if (m.is_finalized && m.winner_member_id) {
            const loserId =
                m.winner_member_id === m.home_member_id ? m.away_member_id : m.home_member_id
            if (map[m.winner_member_id]) map[m.winner_member_id].wins++
            if (map[loserId]) map[loserId].losses++
        } else if (m.is_finalized) {
            if (map[m.home_member_id]) map[m.home_member_id].ties++
            if (map[m.away_member_id]) map[m.away_member_id].ties++
        }
    }

    return Object.values(map).sort(compareStandingsRows)
}
