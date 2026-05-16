import { supabase } from '../lib/supabase'
import { calculateFantasyPoints, snakeToStatLine, getWeekNumberForDate } from '../lib/scoring'
import { notifyMember } from '../lib/notifications'

type MatchupForScore = {
    id: string
    league_id: string
    league_season_id: string
    week_number: number
    home_member_id: string
    away_member_id: string
}

type LineupPlayer = {
    member_id: string
    player_id: string
}

type LineupSlot = LineupPlayer & {
    slot_type: string
}

type StatRow = Record<string, unknown> & {
    player_id: string
}

type MatchupForFinalization = {
    id: string
    home_member_id: string
    away_member_id: string
    home_points: number | null
    away_points: number | null
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

// Loads lineup rows for a week and computes fantasy points per player.
// Shared by both starters-only scoring and max-possible scoring; the caller
// supplies which slot types to include (max-possible includes BE; live
// scoring excludes both BE and IR).
async function loadWeekLineupAndPlayerPoints(
    memberIds: string[],
    leagueSeasonId: string,
    seasonYear: number,
    weekNumber: number,
    settings: Record<string, number>,
    weekStart: string,
    weekEnd: string,
    includeBench: boolean,
): Promise<{ lineupRows: LineupSlot[]; pointsByPlayer: Map<string, number> } | null> {
    let lineupQuery = supabase
        .from('weekly_lineups')
        .select('member_id, player_id, slot_type')
        .in('member_id', memberIds)
        .eq('league_season_id', leagueSeasonId)
        .eq('week_number', weekNumber)
        .neq('slot_type', 'IR')

    if (!includeBench) {
        lineupQuery = lineupQuery.neq('slot_type', 'BE')
    }

    const { data: lineup, error: lineupErr } = await lineupQuery
    if (lineupErr) throw lineupErr
    const lineupRows = (lineup ?? []) as LineupSlot[]
    if (lineupRows.length === 0) return null

    const playerIds = [...new Set(lineupRows.map((r) => r.player_id))]

    // Use game_date range instead of week_number — more reliable when game rows
    // have stale/incorrect week_number values from partial syncs.
    const { data: stats, error: statsErr } = await supabase
        .from('player_game_stats')
        .select(
            'player_id,points,rebounds,assists,steals,blocks,turnovers,' +
                'three_pointers_made,field_goals_made,field_goals_attempted,' +
                'free_throws_made,free_throws_attempted,double_double,triple_double,did_not_play',
        )
        .in('player_id', playerIds)
        .eq('season_year', seasonYear)
        .gte('game_date', weekStart)
        .lte('game_date', weekEnd)

    if (statsErr) throw statsErr

    const pointsByPlayer = new Map<string, number>()
    for (const stat of (stats ?? []) as unknown as StatRow[]) {
        const current = pointsByPlayer.get(stat.player_id) ?? 0
        pointsByPlayer.set(
            stat.player_id,
            current + calculateFantasyPoints(snakeToStatLine(stat), settings),
        )
    }

    return { lineupRows, pointsByPlayer }
}

async function calcWeekPointsByMember(
    memberIds: string[],
    leagueSeasonId: string,
    seasonYear: number,
    weekNumber: number,
    settings: Record<string, number>,
    weekStart: string,
    weekEnd: string,
): Promise<Map<string, number>> {
    if (memberIds.length === 0) return new Map()

    const loaded = await loadWeekLineupAndPlayerPoints(
        memberIds,
        leagueSeasonId,
        seasonYear,
        weekNumber,
        settings,
        weekStart,
        weekEnd,
        false,
    )
    if (!loaded) return new Map(memberIds.map((id) => [id, 0]))
    const { lineupRows, pointsByPlayer } = loaded

    const pointsByMember = new Map(memberIds.map((id) => [id, 0]))
    for (const row of lineupRows) {
        pointsByMember.set(
            row.member_id,
            (pointsByMember.get(row.member_id) ?? 0) + (pointsByPlayer.get(row.player_id) ?? 0),
        )
    }

    for (const [memberId, points] of pointsByMember) {
        pointsByMember.set(memberId, parseFloat(points.toFixed(2)))
    }

    return pointsByMember
}

async function calcWeekMaxPossiblePointsByMember(
    memberIds: string[],
    leagueSeasonId: string,
    seasonYear: number,
    weekNumber: number,
    settings: Record<string, number>,
    weekStart: string,
    weekEnd: string,
): Promise<Map<string, number>> {
    if (memberIds.length === 0) return new Map()

    const loaded = await loadWeekLineupAndPlayerPoints(
        memberIds,
        leagueSeasonId,
        seasonYear,
        weekNumber,
        settings,
        weekStart,
        weekEnd,
        true,
    )
    if (!loaded) return new Map(memberIds.map((id) => [id, 0]))
    const { lineupRows, pointsByPlayer } = loaded

    const starterCounts = new Map(memberIds.map((id) => [id, 0]))
    for (const row of lineupRows) {
        if (row.slot_type !== 'BE') {
            starterCounts.set(row.member_id, (starterCounts.get(row.member_id) ?? 0) + 1)
        }
    }

    const playerScoresByMember = new Map(memberIds.map((id) => [id, [] as number[]]))
    for (const row of lineupRows) {
        playerScoresByMember.get(row.member_id)?.push(pointsByPlayer.get(row.player_id) ?? 0)
    }

    const maxPointsByMember = new Map<string, number>()
    for (const memberId of memberIds) {
        const starterCount = starterCounts.get(memberId) ?? 0
        const scores = [...(playerScoresByMember.get(memberId) ?? [])].sort((a, b) => b - a)
        const maxPoints = scores.slice(0, starterCount).reduce((sum, points) => sum + points, 0)
        maxPointsByMember.set(memberId, parseFloat(maxPoints.toFixed(2)))
    }

    return maxPointsByMember
}

async function insertStandingsSnapshots(
    leagueId: string,
    leagueSeasonId: string,
    weekNumber: number,
    matchups: MatchupForFinalization[],
    maxPossiblePointsByMember: Map<string, number>,
): Promise<void> {
    const memberIds = [
        ...new Set(matchups.flatMap((m) => [m.home_member_id, m.away_member_id])),
    ]
    if (memberIds.length === 0) return

    const { data: existingRows, error: existingErr } = await supabase
        .from('standings')
        .select('member_id')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .eq('week_number', weekNumber)
        .in('member_id', memberIds)
    if (existingErr) throw existingErr
    const existingMembers = new Set((existingRows ?? []).map((row) => row.member_id))

    const { data: previousRows, error: previousErr } = await supabase
        .from('standings')
        .select('member_id, wins, losses, ties, points_for, points_against, max_possible_points, waiver_priority, week_number')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .lt('week_number', weekNumber)
        .in('member_id', memberIds)
        .order('week_number', { ascending: false })
    if (previousErr) throw previousErr

    const previousByMember = new Map<string, StandingSnapshot>()
    for (const row of (previousRows ?? []) as StandingSnapshot[]) {
        if (!previousByMember.has(row.member_id)) {
            previousByMember.set(row.member_id, row)
        }
    }

    const { data: waiverRows, error: waiverErr } = await supabase
        .from('waiver_priorities')
        .select('member_id, priority')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .in('member_id', memberIds)
    if (waiverErr) throw waiverErr
    const waiverPriorityByMember = new Map((waiverRows ?? []).map((row) => [row.member_id, row.priority]))

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

    for (const matchup of matchups) {
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

    const insertRows = [...standingsByMember.values()]
        .filter((row) => !existingMembers.has(row.member_id))
        .map((row) => ({
            league_id: leagueId,
            league_season_id: leagueSeasonId,
            member_id: row.member_id,
            week_number: weekNumber,
            wins: row.wins,
            losses: row.losses,
            ties: row.ties,
            points_for: parseFloat(row.points_for.toFixed(2)),
            points_against: parseFloat(row.points_against.toFixed(2)),
            max_possible_points: parseFloat(row.max_possible_points.toFixed(2)),
            waiver_priority: row.waiver_priority,
        }))

    if (insertRows.length === 0) return
    const { error: insertErr } = await supabase.from('standings').insert(insertRows)
    if (insertErr) throw insertErr
}

// If all games in a week are finished, mark matchups as finalized.
async function finalizeWeekIfComplete(
    leagueId: string,
    leagueSeasonId: string,
    weekNumber: number,
    seasonYear: number,
    settings: Record<string, number>,
) {
    // Get the week's date range from season_weeks (authoritative)
    const { data: weekData } = await supabase
        .from('season_weeks')
        .select('week_start, week_end')
        .eq('season_year', seasonYear)
        .eq('week_number', weekNumber)
        .maybeSingle()

    if (!weekData) return

    // Check for any unfinished games in this week's date range
    const { count: pendingGames } = await supabase
        .from('nba_games')
        .select('id', { count: 'exact', head: true })
        .eq('season_year', seasonYear)
        .gte('game_date', weekData.week_start)
        .lte('game_date', weekData.week_end)
        .in('status', ['Scheduled', 'InProgress'])

    if ((pendingGames ?? 0) > 0) return // week not done yet

    const { data: matchups } = await supabase
        .from('matchups')
        .select('id, home_member_id, away_member_id, home_points, away_points')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .eq('week_number', weekNumber)
        .eq('is_finalized', false)

    if (!matchups?.length) return

    const matchupRows = matchups as MatchupForFinalization[]
    const memberIds = [
        ...new Set(matchupRows.flatMap((m) => [m.home_member_id, m.away_member_id])),
    ]
    const maxPossiblePointsByMember = await calcWeekMaxPossiblePointsByMember(
        memberIds,
        leagueSeasonId,
        seasonYear,
        weekNumber,
        settings,
        weekData.week_start,
        weekData.week_end,
    )

    await insertStandingsSnapshots(
        leagueId,
        leagueSeasonId,
        weekNumber,
        matchupRows,
        maxPossiblePointsByMember,
    )

    // Per-matchup finalization is independent across matchups (different matchup ids,
    // different member pairs), so run them in parallel. Matches prior semantics:
    // the matchup update silently ignores errors, notifications log on failure.
    await Promise.all(
        matchupRows.map(async (m) => {
            const homePoints = Number(m.home_points ?? 0)
            const awayPoints = Number(m.away_points ?? 0)
            const winnerId =
                homePoints === awayPoints
                    ? null
                    : homePoints > awayPoints
                      ? m.home_member_id
                      : m.away_member_id

            await supabase
                .from('matchups')
                .update({
                    home_max_possible_points: maxPossiblePointsByMember.get(m.home_member_id) ?? 0,
                    away_max_possible_points: maxPossiblePointsByMember.get(m.away_member_id) ?? 0,
                    winner_member_id: winnerId,
                    is_finalized: true,
                    finalized_at: new Date().toISOString(),
                })
                .eq('id', m.id)

            if (winnerId === null) {
                const tiePts = homePoints.toFixed(1)
                await Promise.all([
                    notifyMember(m.home_member_id, `Week ${weekNumber} Final`, `You tied ${tiePts}–${tiePts}.`),
                    notifyMember(m.away_member_id, `Week ${weekNumber} Final`, `You tied ${tiePts}–${tiePts}.`),
                ]).catch(console.error)
            } else {
                const loserId = winnerId === m.home_member_id ? m.away_member_id : m.home_member_id
                const winnerPts = Math.max(homePoints, awayPoints).toFixed(1)
                const loserPts = Math.min(homePoints, awayPoints).toFixed(1)
                await Promise.all([
                    notifyMember(winnerId, `Week ${weekNumber} Final`, `You won ${winnerPts}–${loserPts}! 🏆`),
                    notifyMember(loserId, `Week ${weekNumber} Final`, `You lost ${loserPts}–${winnerPts}.`),
                ]).catch(console.error)
            }
        }),
    )

    console.log(`[scores] Finalized week ${weekNumber} for league ${leagueId}`)
}

// Calculates and persists home/away points for all unfinalized matchups in a given week.
async function updateWeekPoints(
    leagueId: string,
    seasonId: string,
    seasonYear: number,
    weekNumber: number,
    settings: Record<string, number>,
): Promise<void> {
    const { data: weekData } = await supabase
        .from('season_weeks')
        .select('week_start, week_end')
        .eq('season_year', seasonYear)
        .eq('week_number', weekNumber)
        .maybeSingle()

    if (!weekData) {
        console.log(`[scores] No season_weeks row for week ${weekNumber}`)
        return
    }

    const { data: matchups, error: matchupErr } = await supabase
        .from('matchups')
        .select('id, league_id, league_season_id, week_number, home_member_id, away_member_id')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .eq('week_number', weekNumber)
        .eq('is_finalized', false)

    if (matchupErr) throw matchupErr
    if (!matchups?.length) return

    console.log(`[scores] Updating points for week ${weekNumber} (${weekData.week_start}–${weekData.week_end}), ${matchups.length} matchup(s)`)

    const matchupRows = matchups as MatchupForScore[]
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

// Main sync: updates live scores for all current-week matchups across all leagues.
export async function syncScores(leagueId?: string) {
    let seasonQuery = supabase
        .from('league_seasons')
        .select('id, league_id, season_year, leagues ( scoring_settings )')
        .eq('is_current', true)

    if (leagueId) seasonQuery = seasonQuery.eq('league_id', leagueId)

    const { data: seasons, error: sErr } = await seasonQuery
    if (sErr) throw sErr
    if (!seasons?.length) return

    // Per-league work is independent across leagues. Run leagues in parallel so the
    // 60s live-poll wall time scales with the slowest league, not the sum.
    // Errors propagate to the caller (Promise.all rejects on first failure) to match
    // the prior for-loop behavior where any throw aborted the sync.
    await Promise.all(
        seasons.map(async (season) => {
            const league = season.leagues as any
            const settings: Record<string, number> = league?.scoring_settings ?? {}

            const weekNumber = await getWeekNumberForDate(new Date(), season.season_year)
            if (!weekNumber) {
                console.log(`[scores] No current week for season ${season.season_year}`)
                return
            }
            // Score every week the season covers — regular season AND playoff weeks
            // (QF at playoff_start_week, SF at +1, Final at +2). updateWeekPoints
            // and finalizeWeekIfComplete are matchup-type agnostic: they sum
            // lineup×stats for whichever matchup rows exist at the given week.
            // Skipping playoff weeks here would leave bracket matchups with null
            // home_points/away_points forever, blocking advanceToFinal.

            console.log(`[scores] Syncing week ${weekNumber} for league ${season.league_id}`)

            // Refresh points for current week and previous week (in case last sync missed
            // final games). These two updates operate on different week rows, so they
            // can run in parallel; but they must complete before finalize reads matchups.
            const updates: Promise<void>[] = [
                updateWeekPoints(season.league_id, season.id, season.season_year, weekNumber, settings),
            ]
            if (weekNumber > 1) {
                updates.push(
                    updateWeekPoints(season.league_id, season.id, season.season_year, weekNumber - 1, settings),
                )
            }
            await Promise.all(updates)

            // Try to finalize both weeks (idempotent — only finalizes when all games are done).
            // Same independence as updates above: different week rows, safe to parallelize.
            const finalizations: Promise<void>[] = [
                finalizeWeekIfComplete(season.league_id, season.id, weekNumber, season.season_year, settings),
            ]
            if (weekNumber > 1) {
                finalizations.push(
                    finalizeWeekIfComplete(season.league_id, season.id, weekNumber - 1, season.season_year, settings),
                )
            }
            await Promise.all(finalizations)
        }),
    )

    console.log('[scores] Sync complete.')
}
