import { supabase } from '../lib/supabase'
import { runBounded } from '../lib/runBounded'
import { getWeekNumberForDate, roundFantasyPoints } from '../lib/scoring'
import { isRegularSeasonGameId } from '../lib/nba'
import { syncStatsForDates } from './stats'
import { toETDate } from '../lib/utils/date'
import type { Json } from '../types/database'
import { calcWeekMaxPossiblePointsByMember, calcWeekPointsByMember } from './scoreLineups'
import {
    fetchAllPages,
    loadLeagueMemberIds,
    loadSeasonWeekBounds,
    weekNumberForGameDate,
    weekRange,
} from './scoreShared'

// NBA stat corrections arrive 1–2 days after a game; past that a Final box score
// is settled and does not need re-fetching. Kept generous over the observed lag.
const STAT_CORRECTION_WINDOW_DAYS = 4

const LEAGUE_SYNC_CONCURRENCY = 8

function errorText(error: unknown): string {
    if (error instanceof AggregateError) {
        return error.errors.map((inner) => errorText(inner)).join('; ')
    }
    return (error as { message?: string } | null)?.message ?? String(error)
}

type MatchupForScore = {
    id: string
    league_id: string
    league_season_id: string
    week_number: number
    end_week_number: number | null
    matchup_type: string
    is_finalized: boolean | null
    home_member_id: string
    away_member_id: string
    home_points: number | null
    away_points: number | null
}


type MatchupForFinalization = {
    id: string
    end_week_number: number | null
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

type MatchupWinnerInput = {
    matchup_type: string
    home_member_id: string
    away_member_id: string
}



type GameDateForRefresh = {
    stats_synced_at: string | null
    game_date: string
    nba_game_id: string | null
    status: string | null
}

type FinalizedRegularSeasonMatchupWeek = {
    week_number: number
    is_finalized: boolean | null
}


type StandingSnapshotMember = {
    week_number: number
    member_id: string
}


function scoringSettingsFromJson(value: Json | null | undefined): Record<string, number> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return {}
    const settings: Record<string, number> = {}
    for (const [key, stat] of Object.entries(value)) {
        if (typeof stat === 'number') settings[key] = stat
    }
    return settings
}

function isPlayoffMatchupType(matchupType: string): boolean {
    return matchupType === 'playoff_quarterfinal' ||
        matchupType === 'playoff_semifinal' ||
        matchupType === 'playoff_final'
}

// Once the next playoff round exists, the prior round's result has been
// consumed by bracket advancement and is immutable: a stat correction landing
// after advancement updates player stat rows but never re-decides the closed
// playoff matchup. Corrections inside the pre-advancement grace window still
// reconcile normally.
async function loadLockedPlayoffTypes(
    leagueId: string,
    leagueSeasonId: string,
): Promise<Set<string>> {
    const data = await fetchAllPages<{ id: string; matchup_type: string; playoff_round: number | null }>((from, to) => supabase
        .from('matchups')
        .select('id, matchup_type, playoff_round')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .eq('is_voided', false)
        .neq('matchup_type', 'regular_season')
        .order('id')
        .range(from, to))
    const present = new Set(data.filter((row) => row.playoff_round == null).map((row) => row.matchup_type))
    const latestRound = data.reduce((latest, row) => Math.max(latest, row.playoff_round ?? 0), 0)
    const locked = new Set(data.filter((row) => row.playoff_round != null && row.playoff_round < latestRound).map((row) => row.id))
    if (present.has('playoff_semifinal')) locked.add('playoff_quarterfinal')
    if (present.has('playoff_final')) locked.add('playoff_semifinal')
    const { data: season, error: seasonError } = await supabase.from('league_seasons')
        .select('is_current').eq('id', leagueSeasonId).eq('league_id', leagueId).single()
    if (seasonError) throw seasonError
    if (!season.is_current) locked.add('playoff_final')
    return locked
}

// Re-arm playoff grace only when its decision changes. The read boundary can
// advance on unchanged polling without delaying bracket advancement.
export type FinalizationCandidate = {
    is_finalized: boolean | null
    winner_member_id: string | null
    home_max_possible_points: number | string | null
    away_max_possible_points: number | string | null
    winnerId: string | null
    homeMaxPossiblePoints: number
    awayMaxPossiblePoints: number
}

export function finalizationWriteNeeded(candidate: FinalizationCandidate): boolean {
    if (!candidate.is_finalized) return true
    if ((candidate.winner_member_id ?? null) !== (candidate.winnerId ?? null)) return true
    const storedHomeMax = candidate.home_max_possible_points == null ? null : Number(candidate.home_max_possible_points)
    const storedAwayMax = candidate.away_max_possible_points == null ? null : Number(candidate.away_max_possible_points)
    return storedHomeMax !== candidate.homeMaxPossiblePoints || storedAwayMax !== candidate.awayMaxPossiblePoints
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
    scoringReadStartedAt: string,
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
        .range(from, to))

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
            .eq('is_voided', false)
            .eq('matchup_type', 'regular_season')
            .lt('week_number', weekNumber)
            .order('week_number')
            .order('id')
            .range(from, to))

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
        .range(from, to))
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

    return [...standingsByMember.values()]
        .map((row) => ({
            league_id: leagueId,
            league_season_id: leagueSeasonId,
            member_id: row.member_id,
            week_number: weekNumber,
            created_at: scoringReadStartedAt,
            wins: row.wins,
            losses: row.losses,
            ties: row.ties,
            points_for: parseFloat(row.points_for.toFixed(2)),
            points_against: parseFloat(row.points_against.toFixed(2)),
            max_possible_points: parseFloat(row.max_possible_points.toFixed(2)),
            waiver_priority: row.waiver_priority,
        }))
}

type ScoringWeek = { week_number: number; week_start: string; week_end: string }

async function loadMatchupWeeks(seasonYear: number, first: number, last: number): Promise<ScoringWeek[]> {
    const { data, error } = await supabase.from('season_weeks')
        .select('week_number, week_start, week_end').eq('season_year', seasonYear)
        .gte('week_number', first).lte('week_number', last).order('week_number')
    if (error) throw error
    if (!data || data.length !== last - first + 1) {
        throw new Error(`Cannot score round: season ${seasonYear} is missing a week between ${first} and ${last}.`)
    }
    return data
}

function addMemberPoints(total: Map<string, number>, week: Map<string, number>) {
    for (const [memberId, points] of week) total.set(memberId, roundFantasyPoints((total.get(memberId) ?? 0) + points))
}

async function loadCertifiedMaxPossiblePoints(
    matchups: MatchupForFinalization[],
    leagueSeasonId: string,
    weekNumber: number,
): Promise<Map<string, number> | null> {
    const pointsByMember = new Map<string, number>()
    for (const matchup of matchups) {
        if (!matchup.is_finalized) return null
        for (const [memberId, value] of [
            [matchup.home_member_id, matchup.home_max_possible_points],
            [matchup.away_member_id, matchup.away_max_possible_points],
        ] as const) {
            if (value == null || !Number.isFinite(Number(value))) return null
            const points = Number(value)
            if (pointsByMember.has(memberId) && pointsByMember.get(memberId) !== points) return null
            pointsByMember.set(memberId, points)
        }
    }
    const { data, error } = await supabase.rpc('get_stale_score_weeks', {
        p_league_season_id: leagueSeasonId, p_through_week: weekNumber,
    })
    if (error) throw error
    if (data == null || data.some((row) => row.week_number === weekNumber)) return null
    return pointsByMember
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
    scoringReadStartedAt: string,
    referenceDate: Date,
    failedRecoveryDates: ReadonlySet<string>,
) {
    const { data: inputToken, error: tokenError } = await supabase.rpc('capture_score_inputs', {
        p_league_season_id: leagueSeasonId, p_week_number: weekNumber,
    })
    if (tokenError) throw tokenError
    const { data: league, error: settingsError } = await supabase.from('leagues')
        .select('scoring_settings').eq('id', leagueId).single()
    if (settingsError) throw settingsError
    const settings = scoringSettingsFromJson(league.scoring_settings)

    // Get the week's date range from season_weeks (authoritative)
    const { data: weekData, error: weekErr } = await supabase
        .from('season_weeks')
        .select('week_start, week_end')
        .eq('season_year', seasonYear)
        .eq('week_number', weekNumber)
        .maybeSingle()
    if (weekErr) throw weekErr

    if (!weekData) return

    const matchups = await fetchAllPages<MatchupForFinalization>((from, to) => supabase
        .from('matchups')
        .select('id, end_week_number, home_member_id, away_member_id, home_points, away_points, home_max_possible_points, away_max_possible_points, winner_member_id, is_finalized, matchup_type')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .eq('is_voided', false)
        .eq('week_number', weekNumber)
        .order('id')
        .range(from, to))
    if (!matchups.length) return
    const endWeek = Math.max(...matchups.map((matchup) => matchup.end_week_number ?? weekNumber))
    if (matchups.some((matchup) => (matchup.end_week_number ?? weekNumber) !== endWeek)) {
        throw new Error('Matchups in the same round have inconsistent end weeks.')
    }
    const weeks = endWeek === weekNumber
        ? [{ ...weekData, week_number: weekNumber }]
        : await loadMatchupWeeks(seasonYear, weekNumber, endWeek)
    const endDate = weeks[weeks.length - 1].week_end
    if ([...failedRecoveryDates].some((date) => date >= weekData.week_start && date <= endDate)) return
    if (matchups.some((matchup) => isPlayoffMatchupType(matchup.matchup_type)) && toETDate(referenceDate) <= endDate) return
    const { data: pendingGames, error: pendingGamesError } = await supabase
        .rpc('get_score_sync_games', { p_start_date: weekData.week_start, p_end_date: endDate, p_season_year: seasonYear })
        .select('id, nba_game_id')
        // Final status alone does not prove that a complete box score exists.
        .or('status.in.(Scheduled,InProgress),and(status.eq.Final,stats_synced_at.is.null)')
    if (pendingGamesError) throw pendingGamesError
    if ((pendingGames ?? []).some((game) => isRegularSeasonGameId(game.nba_game_id))) return

    const lockedTypes = await loadLockedPlayoffTypes(leagueId, leagueSeasonId)
    const decidableMatchups = matchups.filter((m) =>
        !(m.is_finalized && (lockedTypes.has(m.id) || lockedTypes.has(m.matchup_type)))
    )
    if (!decidableMatchups.length) return

    const memberIds = [
        ...new Set(matchups.flatMap((m) => [m.home_member_id, m.away_member_id])),
    ]
    const certifiedMaxPossiblePoints = toETDate(referenceDate) > endDate
        ? await loadCertifiedMaxPossiblePoints(matchups, leagueSeasonId, weekNumber)
        : null
    const maxPossiblePointsByMember = certifiedMaxPossiblePoints ?? new Map<string, number>()
    const pointsByMember = new Map<string, number>()
    for (const week of weeks) {
        if (!certifiedMaxPossiblePoints) {
            addMemberPoints(maxPossiblePointsByMember, await calcWeekMaxPossiblePointsByMember(
                memberIds, leagueId, leagueSeasonId, seasonYear, settings, week.week_start, week.week_end,
            ))
        }
        addMemberPoints(pointsByMember, await calcWeekPointsByMember(
            memberIds, leagueSeasonId, seasonYear, week.week_number, settings, week.week_start, week.week_end,
        ))
    }

    const scoredMatchups = matchups.map((matchup) => ({
        ...matchup,
        home_points: pointsByMember.get(matchup.home_member_id) ?? 0,
        away_points: pointsByMember.get(matchup.away_member_id) ?? 0,
    }))
    const standingsRows = await buildStandingsSnapshotRows(
        leagueId,
        leagueSeasonId,
        weekNumber,
        scoredMatchups,
        maxPossiblePointsByMember,
        scoringReadStartedAt,
    )
    if (standingsRows == null) return

    const matchupResults: MatchupResult[] = decidableMatchups.map((m) => {
        const homePoints = pointsByMember.get(m.home_member_id) ?? 0
        const awayPoints = pointsByMember.get(m.away_member_id) ?? 0
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

    // Every completed read advances its replay boundary. Only a changed decision
    // restarts the playoff grace period.
    const reconciliationTimestamp = new Date().toISOString()
    const finalizedTimestamp = new Date().toISOString()
    const { error: finalizeErr } = await supabase.rpc('finalize_score_week_atomic', {
        p_league_id: leagueId,
        p_league_season_id: leagueSeasonId,
        p_week_number: weekNumber,
        p_matchups: matchupResults.map((m) => ({
            id: m.id,
            home_points: m.homePoints,
            away_points: m.awayPoints,
            score_read_started_at: scoringReadStartedAt,
            input_token: inputToken,
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

    console.log(`[scores] Finalized/reconciled week ${weekNumber} for league ${leagueId}`)
}

// Calculates and persists home/away points for all matchups in a given week.
//
// Finalized playoff points persist with their decision in finalizeWeekIfComplete.
// The database rejects a late live-score write after finalization or advancement.
async function updateWeekPoints(
    leagueId: string,
    seasonId: string,
    seasonYear: number,
    weekNumber: number,
    settings: Record<string, number>,
    onPublicationRetry?: () => void,
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

    const { data: liveInputToken, error: liveTokenError } = await supabase.rpc('capture_score_inputs', {
        p_league_season_id: seasonId,
        p_week_number: weekNumber,
    })
    if (liveTokenError) throw liveTokenError

    const allMatchups = await fetchAllPages<MatchupForScore>((from, to) => supabase
        .from('matchups')
        .select('id, league_id, league_season_id, week_number, end_week_number, matchup_type, is_finalized, home_member_id, away_member_id, home_points, away_points')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .eq('is_voided', false)
        .eq('week_number', weekNumber)
        .order('id')
        .range(from, to))

    if (!allMatchups.length) return

    const lockedTypes = await loadLockedPlayoffTypes(leagueId, seasonId)
    const matchups = allMatchups.filter((m) =>
        !(m.is_finalized && (lockedTypes.has(m.id) || lockedTypes.has(m.matchup_type)))
    )
    if (!matchups.length) return

    console.log(`[scores] Updating points for week ${weekNumber} (${weekData.week_start}–${weekData.week_end}), ${matchups.length} matchup(s)`)

    const memberIds = [
        ...new Set(matchups.flatMap((m) => [m.home_member_id, m.away_member_id])),
    ]
    const endWeek = Math.max(...matchups.map((matchup) => matchup.end_week_number ?? weekNumber))
    if (matchups.some((matchup) => (matchup.end_week_number ?? weekNumber) !== endWeek)) {
        throw new Error('Matchups in the same round have inconsistent end weeks.')
    }
    const weeks = endWeek === weekNumber
        ? [{ ...weekData, week_number: weekNumber }]
        : await loadMatchupWeeks(seasonYear, weekNumber, endWeek)
    const pointsByMember = new Map<string, number>()
    for (const week of weeks) {
        addMemberPoints(pointsByMember, await calcWeekPointsByMember(
            memberIds, seasonId, seasonYear, week.week_number, settings, week.week_start, week.week_end,
        ))
    }

    // matchups has realtime enabled; an unchanged-score upsert still produces WAL
    // and a broadcast to every subscribed client, so no-op rows are filtered out.
    const updates = matchups.flatMap((matchup) => {
        const homePoints = pointsByMember.get(matchup.home_member_id) ?? 0
        const awayPoints = pointsByMember.get(matchup.away_member_id) ?? 0
        if (
            Number(matchup.home_points ?? NaN) === homePoints &&
            Number(matchup.away_points ?? NaN) === awayPoints
        ) return []
        return [{
            id: matchup.id,
            league_id: matchup.league_id,
            league_season_id: matchup.league_season_id,
            week_number: matchup.week_number,
            home_member_id: matchup.home_member_id,
            away_member_id: matchup.away_member_id,
            home_points: homePoints,
            away_points: awayPoints,
            input_token: liveInputToken,
        }]
    })

    if (!updates.length) return

    const { error: updateErr } = await supabase.rpc('update_score_points_atomic', {
        p_league_id: leagueId,
        p_league_season_id: seasonId,
        p_week_number: weekNumber,
        p_matchups: updates,
    })
    if (updateErr) {
        if (onPublicationRetry && (
            updateErr.code === 'PT409' &&
            updateErr.message === 'Score inputs changed or were not certified. Retry scoring.'
        )) {
            onPublicationRetry()
            console.warn(`[scores] Retrying changed inputs for league ${leagueId}, week ${weekNumber}`)
            return await updateWeekPoints(leagueId, seasonId, seasonYear, weekNumber, settings)
        }
        throw updateErr
    }
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
        .eq('is_voided', false)
        .lte('week_number', currentWeek)
        .eq('is_finalized', false)
        .order('week_number')
        .order('id')
        .range(from, to))

    let earliestWeek = currentWeek > 1 ? currentWeek - 1 : currentWeek
    for (const row of unfinalizedRows) {
        if (Number.isInteger(row.week_number) && row.week_number >= 1) {
            earliestWeek = Math.min(earliestWeek, row.week_number)
        }
    }

    const staleWeek = await loadEarliestStatCorrectionWeek(seasonId, currentWeek)
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
        .eq('is_voided', false)
        .eq('matchup_type', 'regular_season')
        .lte('week_number', currentWeek)
        .order('week_number')
        .range(from, to))

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
        .range(from, to))

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
    seasonId: string,
    currentWeek: number,
): Promise<number | null> {
    const { data, error } = await supabase.rpc('get_stale_score_weeks', {
        p_league_season_id: seasonId, p_through_week: currentWeek,
    })
    if (error) throw error
    return data?.[0]?.week_number ?? null
}

async function syncStatsForCompletedWeeks(
    seasonYear: number,
    weeks: number[],
    referenceDate: Date,
    onDateError: (date: string, error: unknown) => void,
): Promise<void> {
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
        .rpc('get_score_sync_games', { p_start_date: firstWeekStart, p_end_date: lastWeekEnd, p_season_year: seasonYear })
        .select('game_date, nba_game_id, status, stats_synced_at')
        .order('game_date')
        .order('nba_game_id')
        .range(from, to))

    const regularGames = games.filter((game) => isRegularSeasonGameId(game.nba_game_id))
    const settledBefore = toETDate(
        new Date(referenceDate.getTime() - STAT_CORRECTION_WINDOW_DAYS * 86_400_000),
    )
    const dateKeys = [
        ...new Set(
            regularGames
                .filter((game) => {
                    const weekNumber = weekNumberForGameDate(game.game_date, weekBounds)
                    if (weekNumber == null || !weekSet.has(weekNumber)) return false
                    if (game.game_date < today) {
                        // Age limits correction polling only after a successful stats sync.
                        // Missing initial box scores still need recovery in longer rounds.
                        return game.status !== 'Final' || game.stats_synced_at == null || game.game_date >= settledBefore
                    }
                    return game.status !== 'Scheduled' && game.status !== 'InProgress'
                })
                .map((game) => game.game_date),
        ),
    ].sort()

    await syncStatsForDates(dateKeys, onDateError)
}

// Update current matchups and replay corrected historical seasons.
export async function syncScores(leagueId?: string, referenceDate = new Date(), options: { recoverStats?: boolean; onPublicationRetry?: () => void } = {}) {
    const seasons = await fetchAllPages<{
        id: string
        league_id: string
        season_year: number
        is_current: boolean
        leagues: { scoring_settings: Json } | null
    }>((from, to) => {
        let query = supabase
            .from('league_seasons')
            .select('id, league_id, season_year, is_current, leagues!league_seasons_league_id_fkey ( scoring_settings )')
            .order('id')

        if (leagueId) query = query.eq('league_id', leagueId)
        return query.range(from, to)
    })
    if (!seasons.length) return

    // Per-league work is independent across leagues. Fan out with bounded
    // concurrency so the 60s live-poll wall clock scales with the slowest
    // leagues without an unbounded connection burst, and isolate per-league
    // failures: one broken or slow league must not abort or starve the rest.
    type SeasonPlan = {
        season: (typeof seasons)[number]
        weekNumber: number
        weeksToSync: number[]
    }
    const plans: SeasonPlan[] = []
    const planFailures: string[] = []
    const weekBySeasonYear = new Map<number, Promise<number | null>>()
    await runBounded(seasons.map((season) => async () => {
        let currentWeek = weekBySeasonYear.get(season.season_year)
        if (!currentWeek) {
            currentWeek = getWeekNumberForDate(referenceDate, season.season_year)
            weekBySeasonYear.set(season.season_year, currentWeek)
        }
        const weekNumber = await currentWeek
        if (!weekNumber) {
            console.log(`[scores] No current week for season ${season.season_year}`)
            return
        }
        let weeksToSync: number[]
        if (season.is_current === false) {
            const staleWeek = await loadEarliestStatCorrectionWeek(season.id, weekNumber)
            if (staleWeek == null) return
            weeksToSync = weekRange(staleWeek, weekNumber)
        } else {
            weeksToSync = await loadWeeksToSync(season.league_id, season.id, season.season_year, weekNumber)
        }
        plans.push({ season, weekNumber, weeksToSync })
    }), LEAGUE_SYNC_CONCURRENCY).catch((error) => {
        planFailures.push(errorText(error))
        console.error(`[scores] planning failed for some league(s): ${errorText(error)}`)
    })

    // Stat sync writes global player_game_stats, so running it per league would
    // duplicate the same CDN box-score fetches and race identical upserts. Run
    // it once per season year over the union of every league's weeks.
    const weeksBySeasonYear = new Map<number, Set<number>>()
    for (const plan of plans) {
        const weeks = weeksBySeasonYear.get(plan.season.season_year) ?? new Set<number>()
        for (const week of plan.weeksToSync) weeks.add(week)
        weeksBySeasonYear.set(plan.season.season_year, weeks)
    }
    const recoveryFailures: Error[] = []
    const failedRecoveryYears = new Set<number>()
    const failedRecoveryDates = new Map<number, Set<string>>()
    for (const [seasonYear, weeks] of options.recoverStats !== false ? weeksBySeasonYear : []) {
        const failedDates = new Set<string>()
        failedRecoveryDates.set(seasonYear, failedDates)
        try {
            await syncStatsForCompletedWeeks(seasonYear, [...weeks].sort((a, b) => a - b), referenceDate, (date, error) => {
                failedDates.add(date)
                recoveryFailures.push(new Error(`${seasonYear}/${date}: ${errorText(error)}`))
            })
        } catch (error) {
            failedRecoveryYears.add(seasonYear)
            recoveryFailures.push(new Error(`${seasonYear}: ${errorText(error)}`))
        }
    }

    const syncFailures: string[] = []
    await runBounded(
        plans.map(({ season, weekNumber, weeksToSync }) => async () => {
            if (failedRecoveryYears.has(season.season_year)) return
            const settings = scoringSettingsFromJson(season.leagues?.scoring_settings)
            // Score every week the season covers. Playoff rounds use the
            // week_number stored on each generated matchup, and the scoring pass
            // is matchup-type agnostic: it sums lineup×stats for whichever rows
            // exist at the given week. Skipping playoff weeks here would leave
            // bracket matchups with null home_points/away_points forever,
            // blocking advanceToFinal.

            console.log(`[scores] Syncing week ${weekNumber} for league ${season.league_id}`)

            // An overlapping correction must remain newer than this read boundary.
            const scoringReadStartedAt = new Date().toISOString()
            for (const scoreWeek of weeksToSync) {
                await updateWeekPoints(season.league_id, season.id, season.season_year, scoreWeek, settings, options.onPublicationRetry)
            }

            // Finalize older weeks before newer weeks so cumulative standings for
            // week N always build on the week N-1 snapshot when both close late.
            for (const finalizeWeek of weeksToSync) {
                await finalizeWeekIfComplete(season.league_id, season.id, finalizeWeek, season.season_year,
                    scoringReadStartedAt, referenceDate, failedRecoveryDates.get(season.season_year) ?? new Set())
            }
        }),
        LEAGUE_SYNC_CONCURRENCY,
    ).catch((error) => {
        syncFailures.push(errorText(error))
        console.error(`[scores] sync failed for some league(s): ${errorText(error)}`)
    })

    // Finish independent healthy work before reporting any incomplete scoring.
    const failures = [...recoveryFailures, ...planFailures.map((message) => new Error(message)),
        ...syncFailures.map((message) => new Error(message))]
    if (failures.length) throw new AggregateError(failures, 'Score sync failed for some inputs; healthy scoring completed')

    console.log('[scores] Sync complete.')
}
