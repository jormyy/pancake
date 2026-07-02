import { supabase } from '../lib/supabase'
import { getWeekNumberForDate } from '../lib/scoring'
import { notifyMember } from '../lib/notifications'
import { isRegularSeasonGameId } from '../lib/nba'
import { syncStatsByDate } from './stats'
import { toETDate } from '../lib/utils/date'
import type { Json } from '../types/database'
import { calcWeekMaxPossiblePointsByMember, calcWeekPointsByMember } from './scoreLineups'
import {
    dateFromETDate,
    fetchAllPages,
    loadLeagueMemberIds,
    loadSeasonWeekBounds,
    weekNumberForGameDate,
    weekRange,
} from './scoreShared'

type MatchupForScore = {
    id: string
    league_id: string
    league_season_id: string
    week_number: number
    home_member_id: string
    away_member_id: string
}


type MatchupForFinalization = {
    id: string
    home_member_id: string
    away_member_id: string
    home_points: number | null
    away_points: number | null
    home_max_possible_points: number | null
    away_max_possible_points: number | null
    winner_member_id: string | null
    is_finalized: boolean | null
    matchup_type: string
}

type PriorMatchupWeek = {
    week_number: number
    home_member_id: string
    away_member_id: string
}

type StandingSnapshot = {
    member_id: string
    wins: number
    losses: number
    ties: number
    points_for: number
    points_against: number
    max_possible_points: number
    waiver_priority: number
}

type PreviousStandingSnapshot = StandingSnapshot & {
    week_number: number
}

type StandingSnapshotUpsertRow = {
    league_id: string
    league_season_id: string
    member_id: string
    week_number: number
    created_at: string
    wins: number
    losses: number
    ties: number
    points_for: number
    points_against: number
    max_possible_points: number
    waiver_priority: number
}

type MatchupResult = MatchupForFinalization & {
    homePoints: number
    awayPoints: number
    winnerId: string | null
    homeMaxPossiblePoints: number
    awayMaxPossiblePoints: number
}

type FinalizedMatchupNotification = {
    id: string
    home_member_id: string
    away_member_id: string
    home_points: number | string | null
    away_points: number | string | null
    winner_member_id: string | null
}

type MatchupWinnerInput = {
    matchup_type: string
    home_member_id: string
    away_member_id: string
}

type StandingSnapshotTimestamp = {
    week_number: number
    created_at: string | null
}

type StatUpdateTimestamp = {
    game_date: string
    updated_at: string | null
    nba_games?: {
        nba_game_id: string | null
    } | null
}

type GameDateForRefresh = {
    game_date: string
    nba_game_id: string | null
    status: string | null
}

type FinalizedRegularSeasonMatchupWeek = {
    week_number: number
    is_finalized: boolean | null
}

type FinalizedPlayoffMatchupTimestamp = {
    week_number: number
    finalized_at: string | null
}

type StandingSnapshotMember = {
    week_number: number
    member_id: string
}


function isPlayoffMatchupType(matchupType: string): boolean {
    return matchupType === 'playoff_quarterfinal' ||
        matchupType === 'playoff_semifinal' ||
        matchupType === 'playoff_final'
}

export function resolveMatchupWinnerForScore(
    matchup: MatchupWinnerInput,
    homePoints: number,
    awayPoints: number,
    homeMaxPossiblePoints: number,
    awayMaxPossiblePoints: number,
): string | null {
    if (homePoints > awayPoints) return matchup.home_member_id
    if (awayPoints > homePoints) return matchup.away_member_id
    if (!isPlayoffMatchupType(matchup.matchup_type)) return null

    if (homeMaxPossiblePoints > awayMaxPossiblePoints) return matchup.home_member_id
    if (awayMaxPossiblePoints > homeMaxPossiblePoints) return matchup.away_member_id
    return matchup.home_member_id
}

async function buildStandingsSnapshotRows(
    leagueId: string,
    leagueSeasonId: string,
    weekNumber: number,
    matchups: MatchupForFinalization[],
    maxPossiblePointsByMember: Map<string, number>,
): Promise<StandingSnapshotUpsertRow[] | null> {
    // Standings (wins/losses/PF/PA/max) only accumulate from regular_season
    // matchups. Playoff matchups (QF/SF/Final) are finalized in the same week
    // loop but must not inflate season records — they're tracked separately
    // via matchups.matchup_type and surfaced through the bracket UI.
    const regularSeasonMatchups = matchups.filter(
        (m) => m.matchup_type === 'regular_season',
    )
    if (regularSeasonMatchups.length === 0) return []

    const matchupMemberIds = [
        ...new Set(regularSeasonMatchups.flatMap((m) => [m.home_member_id, m.away_member_id])),
    ]
    const leagueMemberIds = await loadLeagueMemberIds(leagueId)
    const memberIds = leagueMemberIds.length > 0 ? leagueMemberIds : matchupMemberIds
    if (memberIds.length === 0) return []

    const previousRows = await fetchAllPages<PreviousStandingSnapshot>((from, to) => supabase
        .from('standings')
        .select('member_id, wins, losses, ties, points_for, points_against, max_possible_points, waiver_priority, week_number')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .lt('week_number', weekNumber)
        .in('member_id', memberIds)
        .order('member_id')
        .order('week_number', { ascending: false })
        .range(from, to) as any)

    const previousByMember = new Map<string, PreviousStandingSnapshot>()
    for (const row of previousRows) {
        if (!previousByMember.has(row.member_id)) {
            previousByMember.set(row.member_id, row)
        }
    }

    if (weekNumber > 1) {
        const priorMatchups = await fetchAllPages<PriorMatchupWeek>((from, to) => supabase
            .from('matchups')
            .select('week_number, home_member_id, away_member_id')
            .eq('league_id', leagueId)
            .eq('league_season_id', leagueSeasonId)
            .eq('matchup_type', 'regular_season')
            .lt('week_number', weekNumber)
            .order('week_number')
            .order('id')
            .range(from, to) as any)

        const latestPriorWeekByMember = new Map<string, number>()
        const memberSet = new Set(memberIds)
        for (const matchup of priorMatchups) {
            for (const memberId of [matchup.home_member_id, matchup.away_member_id]) {
                if (!memberSet.has(memberId)) continue
                latestPriorWeekByMember.set(
                    memberId,
                    Math.max(latestPriorWeekByMember.get(memberId) ?? 0, matchup.week_number),
                )
            }
        }

        const missingPrior = memberIds.filter((memberId) => {
            const latestPriorWeek = latestPriorWeekByMember.get(memberId) ?? 0
            if (latestPriorWeek === 0) return false
            return (previousByMember.get(memberId)?.week_number ?? 0) < latestPriorWeek
        })
        if (missingPrior.length > 0) {
            console.log(
                `[scores] Deferring week ${weekNumber} finalization for league ${leagueId}; missing prior standings for ${missingPrior.length} member(s)`,
            )
            return null
        }
    }

    const waiverRows = await fetchAllPages<{ member_id: string; priority: number }>((from, to) => supabase
        .from('waiver_priorities')
        .select('member_id, priority')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .in('member_id', memberIds)
        .order('member_id')
        .range(from, to) as any)
    const waiverPriorityByMember = new Map(waiverRows.map((row) => [row.member_id, row.priority]))

    const standingsByMember = new Map<string, StandingSnapshot>()
    for (const memberId of memberIds) {
        const previous = previousByMember.get(memberId)
        standingsByMember.set(memberId, {
            member_id: memberId,
            wins: previous?.wins ?? 0,
            losses: previous?.losses ?? 0,
            ties: previous?.ties ?? 0,
            points_for: Number(previous?.points_for ?? 0),
            points_against: Number(previous?.points_against ?? 0),
            max_possible_points: Number(previous?.max_possible_points ?? 0),
            waiver_priority: waiverPriorityByMember.get(memberId) ?? previous?.waiver_priority ?? 0,
        })
    }

    for (const matchup of regularSeasonMatchups) {
        const home = standingsByMember.get(matchup.home_member_id)
        const away = standingsByMember.get(matchup.away_member_id)
        if (!home || !away) continue

        const homePoints = Number(matchup.home_points ?? 0)
        const awayPoints = Number(matchup.away_points ?? 0)
        home.points_for += homePoints
        home.points_against += awayPoints
        home.max_possible_points += maxPossiblePointsByMember.get(matchup.home_member_id) ?? 0
        away.points_for += awayPoints
        away.points_against += homePoints
        away.max_possible_points += maxPossiblePointsByMember.get(matchup.away_member_id) ?? 0

        if (homePoints > awayPoints) {
            home.wins += 1
            away.losses += 1
        } else if (awayPoints > homePoints) {
            away.wins += 1
            home.losses += 1
        } else {
            home.ties += 1
            away.ties += 1
        }
    }

    const snapshotCreatedAt = new Date().toISOString()
    return [...standingsByMember.values()]
        .map((row) => ({
            league_id: leagueId,
            league_season_id: leagueSeasonId,
            member_id: row.member_id,
            week_number: weekNumber,
            created_at: snapshotCreatedAt,
            wins: row.wins,
            losses: row.losses,
            ties: row.ties,
            points_for: parseFloat(row.points_for.toFixed(2)),
            points_against: parseFloat(row.points_against.toFixed(2)),
            max_possible_points: parseFloat(row.max_possible_points.toFixed(2)),
            waiver_priority: row.waiver_priority,
        }))
}

function finalizedMatchupNotifications(value: Json | undefined): FinalizedMatchupNotification[] {
    if (!Array.isArray(value)) return []

    return value.flatMap((row) => {
        if (row == null || typeof row !== 'object' || Array.isArray(row)) return []
        const record = row as Record<string, Json | undefined>
        const id = record.id
        const homeMemberId = record.home_member_id
        const awayMemberId = record.away_member_id
        const winnerMemberId = record.winner_member_id
        if (
            typeof id !== 'string' ||
            typeof homeMemberId !== 'string' ||
            typeof awayMemberId !== 'string' ||
            (winnerMemberId != null && typeof winnerMemberId !== 'string')
        ) {
            return []
        }

        return [{
            id,
            home_member_id: homeMemberId,
            away_member_id: awayMemberId,
            home_points: typeof record.home_points === 'number' || typeof record.home_points === 'string' ? record.home_points : null,
            away_points: typeof record.away_points === 'number' || typeof record.away_points === 'string' ? record.away_points : null,
            winner_member_id: winnerMemberId ?? null,
        }]
    })
}

async function notifyFinalizedMatchups(weekNumber: number, rows: FinalizedMatchupNotification[]): Promise<void> {
    await Promise.all(
        rows.map(async (m) => {
            const homePoints = Number(m.home_points ?? 0)
            const awayPoints = Number(m.away_points ?? 0)

            if (m.winner_member_id === null) {
                const tiePts = homePoints.toFixed(2)
                await Promise.all([
                    notifyMember(m.home_member_id, `Week ${weekNumber} Final`, `You tied ${tiePts}–${tiePts}.`),
                    notifyMember(m.away_member_id, `Week ${weekNumber} Final`, `You tied ${tiePts}–${tiePts}.`),
                ]).catch(console.error)
                return
            }

            const loserId = m.winner_member_id === m.home_member_id ? m.away_member_id : m.home_member_id
            const winnerPts = Math.max(homePoints, awayPoints).toFixed(2)
            const loserPts = Math.min(homePoints, awayPoints).toFixed(2)
            await Promise.all([
                notifyMember(m.winner_member_id, `Week ${weekNumber} Final`, `You won ${winnerPts}–${loserPts}! 🏆`),
                notifyMember(loserId, `Week ${weekNumber} Final`, `You lost ${loserPts}–${winnerPts}.`),
            ]).catch(console.error)
        }),
    )
}

// If all games in a week are finished, mark matchups as finalized. Already
// finalized rows are reconciled without notifications so late NBA stat
// corrections cannot leave displayed scores, winners, max possible, and
// standings snapshots out of sync.
async function finalizeWeekIfComplete(
    leagueId: string,
    leagueSeasonId: string,
    weekNumber: number,
    seasonYear: number,
    settings: Record<string, number>,
) {
    // Get the week's date range from season_weeks (authoritative)
    const { data: weekData, error: weekErr } = await supabase
        .from('season_weeks')
        .select('week_start, week_end')
        .eq('season_year', seasonYear)
        .eq('week_number', weekNumber)
        .maybeSingle()
    if (weekErr) throw weekErr

    if (!weekData) return

    // Check for unfinished regular-season games only. Preseason/play-in rows can
    // share the same date range but must not block fantasy week finalization.
    const { data: pendingGames, error: pendingGamesError } = await supabase
        .from('nba_games')
        .select('id, nba_game_id')
        .eq('season_year', seasonYear)
        .gte('game_date', weekData.week_start)
        .lte('game_date', weekData.week_end)
        .in('status', ['Scheduled', 'InProgress'])
    if (pendingGamesError) throw pendingGamesError

    if ((pendingGames ?? []).some((game) => isRegularSeasonGameId(game.nba_game_id))) return // week not done yet

    const matchups = await fetchAllPages<MatchupForFinalization>((from, to) => supabase
        .from('matchups')
        .select('id, home_member_id, away_member_id, home_points, away_points, home_max_possible_points, away_max_possible_points, winner_member_id, is_finalized, matchup_type')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .eq('week_number', weekNumber)
        .order('id')
        .range(from, to) as any)

    if (!matchups.length) return

    const matchupRows = matchups
    const memberIds = [
        ...new Set(matchupRows.flatMap((m) => [m.home_member_id, m.away_member_id])),
    ]
    const maxPossiblePointsByMember = await calcWeekMaxPossiblePointsByMember(
        memberIds,
        leagueId,
        leagueSeasonId,
        seasonYear,
        settings,
        weekData.week_start,
        weekData.week_end,
    )

    const standingsRows = await buildStandingsSnapshotRows(
        leagueId,
        leagueSeasonId,
        weekNumber,
        matchupRows,
        maxPossiblePointsByMember,
    )
    if (standingsRows == null) return

    const matchupResults: MatchupResult[] = matchupRows.map((m) => {
        const homePoints = Number(m.home_points ?? 0)
        const awayPoints = Number(m.away_points ?? 0)
        const homeMaxPossiblePoints = maxPossiblePointsByMember.get(m.home_member_id) ?? 0
        const awayMaxPossiblePoints = maxPossiblePointsByMember.get(m.away_member_id) ?? 0
        const winnerId = resolveMatchupWinnerForScore(
            m,
            homePoints,
            awayPoints,
            homeMaxPossiblePoints,
            awayMaxPossiblePoints,
        )
        return {
            ...m,
            homePoints,
            awayPoints,
            winnerId,
            homeMaxPossiblePoints,
            awayMaxPossiblePoints,
        }
    })

    const reconciliationTimestamp = new Date().toISOString()
    const finalizedTimestamp = new Date().toISOString()
    const { data: notificationData, error: finalizeErr } = await supabase.rpc('finalize_score_week_atomic', {
        p_league_id: leagueId,
        p_league_season_id: leagueSeasonId,
        p_week_number: weekNumber,
        p_matchups: matchupResults.map((m) => ({
            id: m.id,
            winner_member_id: m.winnerId,
            home_max_possible_points: m.homeMaxPossiblePoints,
            away_max_possible_points: m.awayMaxPossiblePoints,
        })),
        p_standings: standingsRows.map((row) => ({
            member_id: row.member_id,
            created_at: row.created_at,
            wins: row.wins,
            losses: row.losses,
            ties: row.ties,
            points_for: row.points_for,
            points_against: row.points_against,
            max_possible_points: row.max_possible_points,
            waiver_priority: row.waiver_priority,
        })),
        p_finalized_at: finalizedTimestamp,
        p_reconciliation_at: reconciliationTimestamp,
    })
    if (finalizeErr) throw finalizeErr

    await notifyFinalizedMatchups(weekNumber, finalizedMatchupNotifications(notificationData))

    console.log(`[scores] Finalized/reconciled week ${weekNumber} for league ${leagueId}`)
}

// Calculates and persists home/away points for all matchups in a given week.
//
// Design: points always recompute (no is_finalized filter) so that NBA stat
// corrections — which often arrive 1–2 days after a game — propagate into
// finalized matchup rows. finalizeWeekIfComplete then reconciles winner,
// max-possible, and standings snapshots while avoiding duplicate notifications.
async function updateWeekPoints(
    leagueId: string,
    seasonId: string,
    seasonYear: number,
    weekNumber: number,
    settings: Record<string, number>,
): Promise<void> {
    const { data: weekData, error: weekErr } = await supabase
        .from('season_weeks')
        .select('week_start, week_end')
        .eq('season_year', seasonYear)
        .eq('week_number', weekNumber)
        .maybeSingle()
    if (weekErr) throw weekErr

    if (!weekData) {
        console.log(`[scores] No season_weeks row for week ${weekNumber}`)
        return
    }

    const matchups = await fetchAllPages<MatchupForScore>((from, to) => supabase
        .from('matchups')
        .select('id, league_id, league_season_id, week_number, home_member_id, away_member_id')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .eq('week_number', weekNumber)
        .order('id')
        .range(from, to) as any)

    if (!matchups.length) return

    console.log(`[scores] Updating points for week ${weekNumber} (${weekData.week_start}–${weekData.week_end}), ${matchups.length} matchup(s)`)

    const matchupRows = matchups
    const memberIds = [
        ...new Set(matchupRows.flatMap((m) => [m.home_member_id, m.away_member_id])),
    ]
    const pointsByMember = await calcWeekPointsByMember(
        memberIds,
        seasonId,
        seasonYear,
        weekNumber,
        settings,
        weekData.week_start,
        weekData.week_end,
    )

    const updates = matchupRows.map((matchup) => ({
        id: matchup.id,
        league_id: matchup.league_id,
        league_season_id: matchup.league_season_id,
        week_number: matchup.week_number,
        home_member_id: matchup.home_member_id,
        away_member_id: matchup.away_member_id,
        home_points: pointsByMember.get(matchup.home_member_id) ?? 0,
        away_points: pointsByMember.get(matchup.away_member_id) ?? 0,
    }))

    const { error: updateErr } = await supabase
        .from('matchups')
        .upsert(updates, { onConflict: 'id' })
    if (updateErr) throw updateErr
}

async function loadWeeksToSync(
    leagueId: string,
    seasonId: string,
    seasonYear: number,
    currentWeek: number,
): Promise<number[]> {
    const unfinalizedRows = await fetchAllPages<{ id: string; week_number: number }>((from, to) => supabase
        .from('matchups')
        .select('id, week_number')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .lte('week_number', currentWeek)
        .eq('is_finalized', false)
        .order('week_number')
        .order('id')
        .range(from, to) as any)

    let earliestWeek = currentWeek > 1 ? currentWeek - 1 : currentWeek
    for (const row of unfinalizedRows) {
        if (Number.isInteger(row.week_number) && row.week_number >= 1) {
            earliestWeek = Math.min(earliestWeek, row.week_number)
        }
    }

    const staleWeek = await loadEarliestStatCorrectionWeek(leagueId, seasonId, seasonYear, currentWeek)
    if (staleWeek != null) {
        earliestWeek = Math.min(earliestWeek, staleWeek)
    }

    const missingSnapshotWeek = await loadEarliestMissingFinalizedSnapshotWeek(leagueId, seasonId, currentWeek)
    if (missingSnapshotWeek != null) {
        earliestWeek = Math.min(earliestWeek, missingSnapshotWeek)
    }

    return weekRange(earliestWeek, currentWeek)
}

async function loadEarliestMissingFinalizedSnapshotWeek(
    leagueId: string,
    seasonId: string,
    currentWeek: number,
): Promise<number | null> {
    const memberIds = await loadLeagueMemberIds(leagueId)
    if (memberIds.length === 0) return null

    const matchupRows = await fetchAllPages<FinalizedRegularSeasonMatchupWeek>((from, to) => supabase
        .from('matchups')
        .select('week_number, is_finalized')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .eq('matchup_type', 'regular_season')
        .lte('week_number', currentWeek)
        .order('week_number')
        .range(from, to) as any)

    const statusByWeek = new Map<number, { total: number; finalized: number }>()
    for (const row of matchupRows) {
        const weekNumber = Number(row.week_number)
        if (!Number.isInteger(weekNumber) || weekNumber < 1) continue
        const status = statusByWeek.get(weekNumber) ?? { total: 0, finalized: 0 }
        status.total += 1
        if (row.is_finalized) status.finalized += 1
        statusByWeek.set(weekNumber, status)
    }

    const finalizedWeeks = [...statusByWeek.entries()]
        .filter(([, status]) => status.total > 0 && status.finalized === status.total)
        .map(([weekNumber]) => weekNumber)
        .sort((a, b) => a - b)
    if (finalizedWeeks.length === 0) return null

    const snapshotRows = await fetchAllPages<StandingSnapshotMember>((from, to) => supabase
        .from('standings')
        .select('week_number, member_id')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .in('week_number', finalizedWeeks)
        .order('week_number')
        .order('member_id')
        .range(from, to) as any)

    const snapshotMembersByWeek = new Map<number, Set<string>>()
    for (const row of snapshotRows) {
        const weekNumber = Number(row.week_number)
        if (!Number.isInteger(weekNumber)) continue
        const members = snapshotMembersByWeek.get(weekNumber) ?? new Set<string>()
        members.add(row.member_id)
        snapshotMembersByWeek.set(weekNumber, members)
    }

    for (const weekNumber of finalizedWeeks) {
        if ((snapshotMembersByWeek.get(weekNumber)?.size ?? 0) < memberIds.length) {
            return weekNumber
        }
    }

    return null
}

async function loadEarliestStatCorrectionWeek(
    leagueId: string,
    seasonId: string,
    seasonYear: number,
    currentWeek: number,
): Promise<number | null> {
    const weekBounds = await loadSeasonWeekBounds(seasonYear, currentWeek)
    if (weekBounds.length === 0) return null

    const snapshots = await fetchAllPages<StandingSnapshotTimestamp>((from, to) => supabase
        .from('standings')
        .select('week_number, created_at')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .lte('week_number', currentWeek)
        .order('week_number')
        .range(from, to) as any)

    const snapshotTimeByWeek = new Map<number, number>()
    for (const row of snapshots) {
        const weekNumber = Number(row.week_number)
        const createdAt = row.created_at ? Date.parse(row.created_at) : NaN
        if (!Number.isInteger(weekNumber) || Number.isNaN(createdAt)) continue
        snapshotTimeByWeek.set(
            weekNumber,
            Math.min(snapshotTimeByWeek.get(weekNumber) ?? Number.POSITIVE_INFINITY, createdAt),
        )
    }

    const playoffRows = await fetchAllPages<FinalizedPlayoffMatchupTimestamp>((from, to) => supabase
        .from('matchups')
        .select('week_number, finalized_at')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .in('matchup_type', ['playoff_quarterfinal', 'playoff_semifinal', 'playoff_final'])
        .eq('is_finalized', true)
        .lte('week_number', currentWeek)
        .order('week_number')
        .range(from, to) as any)

    const playoffFinalizationTimeByWeek = new Map<number, number>()
    for (const row of playoffRows) {
        const weekNumber = Number(row.week_number)
        const finalizedAt = row.finalized_at ? Date.parse(row.finalized_at) : NaN
        if (!Number.isInteger(weekNumber) || Number.isNaN(finalizedAt)) continue
        playoffFinalizationTimeByWeek.set(
            weekNumber,
            Math.min(playoffFinalizationTimeByWeek.get(weekNumber) ?? Number.POSITIVE_INFINITY, finalizedAt),
        )
    }

    if (snapshotTimeByWeek.size === 0 && playoffFinalizationTimeByWeek.size === 0) return null

    const firstWeekStart = weekBounds[0]?.week_start
    const lastWeekEnd = weekBounds[weekBounds.length - 1]?.week_end
    if (!firstWeekStart || !lastWeekEnd) return null

    const statRows = await fetchAllPages<StatUpdateTimestamp>((from, to) => supabase
        .from('player_game_stats')
        .select('game_date, updated_at, nba_games!inner(nba_game_id)')
        .eq('season_year', seasonYear)
        .gte('game_date', firstWeekStart)
        .lte('game_date', lastWeekEnd)
        .order('game_date')
        .range(from, to) as any)

    let earliest: number | null = null
    for (const row of statRows) {
        if (!isRegularSeasonGameId(row.nba_games?.nba_game_id)) continue
        const weekNumber = weekNumberForGameDate(row.game_date, weekBounds)
        if (weekNumber == null) continue
        const updatedAt = row.updated_at ? Date.parse(row.updated_at) : NaN
        const referenceTimes = [
            snapshotTimeByWeek.get(weekNumber),
            playoffFinalizationTimeByWeek.get(weekNumber),
        ].filter((time): time is number => time != null)
        if (referenceTimes.length === 0 || Number.isNaN(updatedAt)) continue
        const referenceTime = Math.min(...referenceTimes)
        if (updatedAt > referenceTime) {
            earliest = earliest == null ? weekNumber : Math.min(earliest, weekNumber)
        }
    }
    return earliest
}

async function syncStatsForCompletedWeeks(seasonYear: number, weeks: number[], referenceDate = new Date()): Promise<void> {
    if (weeks.length === 0) return

    const weekSet = new Set(weeks)
    const weekBounds = (await loadSeasonWeekBounds(seasonYear, Math.max(...weeks)))
        .filter((week) => weekSet.has(week.week_number))
    if (weekBounds.length === 0) return

    const firstWeekStart = weekBounds[0]?.week_start
    const lastWeekEnd = weekBounds[weekBounds.length - 1]?.week_end
    if (!firstWeekStart || !lastWeekEnd) return

    const today = toETDate(referenceDate)
    const games = await fetchAllPages<GameDateForRefresh>((from, to) => supabase
        .from('nba_games')
        .select('game_date, nba_game_id, status')
        .eq('season_year', seasonYear)
        .gte('game_date', firstWeekStart)
        .lte('game_date', lastWeekEnd)
        .order('game_date')
        .order('nba_game_id')
        .range(from, to) as any)

    const regularGames = games.filter((game) => isRegularSeasonGameId(game.nba_game_id))
    const dateKeys = [
        ...new Set(
            regularGames
                .filter((game) => {
                    const weekNumber = weekNumberForGameDate(game.game_date, weekBounds)
                    if (weekNumber == null || !weekSet.has(weekNumber)) return false
                    if (game.game_date < today) return true
                    return game.status !== 'Scheduled' && game.status !== 'InProgress'
                })
                .map((game) => game.game_date),
        ),
    ].sort()

    for (const dateKey of dateKeys) {
        await syncStatsByDate(dateFromETDate(dateKey))
    }
}

// Main sync: updates live scores for all current-week matchups across all leagues.
export async function syncScores(leagueId?: string, referenceDate = new Date()) {
    const seasons = await fetchAllPages<{
        id: string
        league_id: string
        season_year: number
        leagues: unknown
    }>((from, to) => {
        let query = supabase
            .from('league_seasons')
            .select('id, league_id, season_year, leagues!league_seasons_league_id_fkey ( scoring_settings )')
            .eq('is_current', true)
            .order('id')

        if (leagueId) query = query.eq('league_id', leagueId)
        return query.range(from, to) as any
    })
    if (!seasons.length) return

    // Per-league work is independent across leagues. Run leagues in parallel so the
    // 60s live-poll wall time scales with the slowest league, not the sum.
    // Errors propagate to the caller (Promise.all rejects on first failure) to match
    // the prior for-loop behavior where any throw aborted the sync.
    await Promise.all(
        seasons.map(async (season) => {
            const league = season.leagues as any
            const settings: Record<string, number> = league?.scoring_settings ?? {}

            const weekNumber = await getWeekNumberForDate(referenceDate, season.season_year)
            if (!weekNumber) {
                console.log(`[scores] No current week for season ${season.season_year}`)
                return
            }
            // Score every week the season covers. Playoff rounds use the
            // week_number stored on each generated matchup, and the scoring pass
            // is matchup-type agnostic: it sums lineup×stats for whichever rows
            // exist at the given week. Skipping playoff weeks here would leave
            // bracket matchups with null home_points/away_points forever,
            // blocking advanceToFinal.

            console.log(`[scores] Syncing week ${weekNumber} for league ${season.league_id}`)

            const weeksToSync = await loadWeeksToSync(season.league_id, season.id, season.season_year, weekNumber)
            await syncStatsForCompletedWeeks(season.season_year, weeksToSync, referenceDate)
            for (const scoreWeek of weeksToSync) {
                await updateWeekPoints(season.league_id, season.id, season.season_year, scoreWeek, settings)
            }

            // Finalize older weeks before newer weeks so cumulative standings for
            // week N always build on the week N-1 snapshot when both close late.
            for (const finalizeWeek of weeksToSync) {
                await finalizeWeekIfComplete(season.league_id, season.id, finalizeWeek, season.season_year, settings)
            }
        }),
    )

    console.log('[scores] Sync complete.')
}
