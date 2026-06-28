import { supabase } from '@/lib/supabase'
import type { RosterSlotType } from '@/types/database'
import { canPlaySlot, SLOT_ELIGIBLE } from '@/constants/slots'
import { todayET } from '@/lib/shared/dates'
import { isIREligible } from '@/lib/roster'
import { getEligiblePositions } from '@/lib/players'
import { getWeekDays } from './read'

type LineupAssignment = {
    player_id: string
    slot_type: RosterSlotType
    is_auto_set: boolean
    week_number: number
}

type SeasonWeekRow = {
    week_number: number
    week_start: string
}
type RosterPlayerRow = {
    player_id: string
    players: {
        position: string | null
        eligible_positions: string[] | null
        nba_team: string | null
        injury_status: string | null
    } | null
}
type StarterTemplate = {
    slot_type: string
    slot_count: number
}
type PlayerAverageRow = {
    player_id: string
    games_played: number | null
    avg_points: number | null
    avg_rebounds: number | null
    avg_assists: number | null
    avg_steals: number | null
    avg_blocks: number | null
    avg_turnovers: number | null
    avg_three_pointers_made: number | null
    avg_field_goals_made: number | null
    avg_field_goals_attempted: number | null
    avg_free_throws_made: number | null
    avg_free_throws_attempted: number | null
    double_doubles: number | null
    triple_doubles: number | null
}
type LeagueScoringRow = {
    scoring_settings: Record<string, unknown> | null
}
type AutoSetPlayer = {
    playerId: string
    eligiblePositions: string[]
    nbaTeam: string | null
    projected: number
}
type GameRow = {
    home_team: string | null
    away_team: string | null
    status: string | null
    game_time: string | null
}
type WeeklyLineupRow = {
    player_id: string
    slot_type: RosterSlotType
}

async function getRemainingSeasonDates(
    fromWeek: number,
    seasonYear: number,
): Promise<{ date: string; weekNumber: number }[]> {
    // `today` filters dates that flow into autoSetForDate, where they're
    // compared against nba_games.game_date / weekly_lineups.game_date (both
    // ET-keyed). Use todayET so non-ET clients don't include already-past
    // ET dates and silently wipe scored weekly_lineups rows.
    const today = todayET()
    const { data: weeks, error: weeksErr } = await supabase
        .from('season_weeks')
        .select('week_number, week_start')
        .eq('season_year', seasonYear)
        .gte('week_number', fromWeek)
        .order('week_number', { ascending: true })
    if (weeksErr) throw weeksErr

    const result: { date: string; weekNumber: number }[] = []
    for (const w of (weeks ?? []) as SeasonWeekRow[]) {
        const start = new Date(w.week_start + 'T12:00:00Z')
        const dow = start.getUTCDay()
        start.setUTCDate(start.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
        for (let i = 0; i < 7; i++) {
            const d = new Date(start)
            d.setUTCDate(d.getUTCDate() + i)
            const dateStr = d.toISOString().split('T')[0]
            if (dateStr >= today) {
                result.push({ date: dateStr, weekNumber: w.week_number })
            }
        }
    }
    return result
}

// Auto-set lineup for a single day or the full week.
// For each day: players who have an NBA game that day are prioritized as starters,
// then filled in by projected points. Players without games land on bench.
export async function autoSetLineup(
    memberId: string,
    leagueId: string,
    seasonId: string,
    weekNumber: number,
    seasonYear: number,
    gameDate: string | null, // null = whole week
    restOfSeason?: boolean,
): Promise<void> {
    const [{ data: roster, error: rosterErr }, { data: templates, error: templatesErr }] = await Promise.all([
        supabase
            .from('roster_players')
            .select('id, player_id, players(position, eligible_positions, nba_team, injury_status)')
            .eq('member_id', memberId)
            .eq('league_id', leagueId)
            .eq('league_season_id', seasonId)
            .eq('is_on_ir', false)
            .eq('is_on_taxi', false),
        supabase
            .from('lineup_slot_templates')
            .select('slot_type, slot_count')
            .eq('league_id', leagueId),
    ])
    if (rosterErr) throw rosterErr
    if (templatesErr) throw templatesErr

    const rosterRows = (roster ?? []) as RosterPlayerRow[]
    const playerIds = rosterRows.map((row) => row.player_id)

    // Use mv_player_season_averages (1 row per player, already excludes did_not_play games)
    // instead of querying raw player_game_stats. The raw query has no explicit limit and
    // Supabase truncates at 1000 rows — with 15+ players × 70+ games each, some players'
    // stats get silently dropped, giving them projected = 0 and leaving them on bench.
    const [{ data: avgRows, error: avgErr }, { data: leagueRow, error: leagueErr }] = await Promise.all([
        supabase
            .from('mv_player_season_averages')
            .select('player_id, games_played, avg_points, avg_rebounds, avg_assists, avg_steals, avg_blocks, avg_turnovers, avg_three_pointers_made, avg_field_goals_made, avg_field_goals_attempted, avg_free_throws_made, avg_free_throws_attempted, double_doubles, triple_doubles')
            .eq('season_year', seasonYear)
            .in('player_id', playerIds),
        supabase
            .from('leagues')
            .select('scoring_settings')
            .eq('id', leagueId)
            .single(),
    ])
    if (avgErr) throw avgErr
    if (leagueErr) throw leagueErr

    const scoringSettings = ((leagueRow as LeagueScoringRow | null)?.scoring_settings ?? {})
    const scoringValue = (key: string) => Number(scoringSettings[key] ?? 0)

    const avgFptsMap = new Map<string, number>()
    for (const row of (avgRows ?? []) as PlayerAverageRow[]) {
        const gp = Number(row.games_played) || 0
        const fpts =
            Number(row.avg_points ?? 0)                * scoringValue('points') +
            Number(row.avg_rebounds ?? 0)              * scoringValue('rebounds') +
            Number(row.avg_assists ?? 0)               * scoringValue('assists') +
            Number(row.avg_steals ?? 0)                * scoringValue('steals') +
            Number(row.avg_blocks ?? 0)                * scoringValue('blocks') +
            Number(row.avg_turnovers ?? 0)             * scoringValue('turnovers') +
            Number(row.avg_three_pointers_made ?? 0)   * scoringValue('three_pointers_made') +
            Number(row.avg_field_goals_made ?? 0)      * scoringValue('field_goals_made') +
            Number(row.avg_field_goals_attempted ?? 0) * scoringValue('field_goals_attempted') +
            Number(row.avg_free_throws_made ?? 0)      * scoringValue('free_throws_made') +
            Number(row.avg_free_throws_attempted ?? 0) * scoringValue('free_throws_attempted') +
            (gp > 0 ? (Number(row.double_doubles ?? 0) / gp) * scoringValue('double_double') : 0) +
            (gp > 0 ? (Number(row.triple_doubles ?? 0) / gp) * scoringValue('triple_double') : 0)
        avgFptsMap.set(row.player_id, fpts)
    }

    const players = rosterRows.map((row) => {
        const injured = isIREligible(row.players?.injury_status ?? null)
        return {
            playerId: row.player_id,
            eligiblePositions: getEligiblePositions(row.players ?? {}),
            nbaTeam: row.players?.nba_team ?? null,
            projected: injured ? 0 : (avgFptsMap.get(row.player_id) ?? 0),
        }
    })

    const starterTemplates = ((templates ?? []) as StarterTemplate[]).filter(
        (template) => template.slot_type !== 'BE' && template.slot_type !== 'IR' && template.slot_type !== 'TX',
    )

    // Dates here feed into autoSetForDate where they're matched against
    // nba_games.game_date / weekly_lineups.game_date (ET-keyed). Use todayET
    // so the past-date filter aligns with the backend's ET boundary.
    const today = todayET()
    let datesToProcess: { date: string; weekNumber: number }[]

    if (restOfSeason) {
        datesToProcess = await getRemainingSeasonDates(weekNumber, seasonYear)
    } else {
        const allDates = gameDate
            ? [gameDate]
            : (await getWeekDays(weekNumber, seasonYear)).map((d) => d.date)
        datesToProcess = allDates
            .filter((d) => d >= today)
            .map((d) => ({ date: d, weekNumber }))
    }

    // Each date's writes target a distinct game_date and use only read-only inputs
    // (players, starterTemplates) — safe to parallelize. Chunk to bound concurrent
    // Supabase requests; Promise.all still rejects on first failure, preserving
    // the original throw semantics of the serial for-loop.
    const CHUNK = 5
    for (let i = 0; i < datesToProcess.length; i += CHUNK) {
        const chunk = datesToProcess.slice(i, i + CHUNK)
        await Promise.all(
            chunk.map(({ date, weekNumber: wn }) =>
                autoSetForDate(
                    memberId, leagueId, seasonId, wn, seasonYear,
                    date, players, starterTemplates,
                ),
            ),
        )
    }
}

async function autoSetForDate(
    memberId: string,
    leagueId: string,
    seasonId: string,
    weekNumber: number,
    seasonYear: number,
    gameDate: string,
    players: AutoSetPlayer[],
    starterTemplates: StarterTemplate[],
): Promise<void> {
    // Skip past dates - lineups for already-played games should remain locked.
    // gameDate aligns with nba_games.game_date / weekly_lineups.game_date (ET),
    // so compare against todayET. Otherwise auto_set_lineup_atomic's
    // DELETE-then-INSERT can wipe already-scored weekly_lineups rows for
    // non-ET clients during the 0–3h skew window.
    if (gameDate < todayET()) return

    const [{ data: games, error: gamesErr }, { data: existingEntries, error: existingErr }] = await Promise.all([
        supabase
            .from('nba_games')
            .select('home_team, away_team, status, game_time')
            .eq('season_year', seasonYear)
            .eq('game_date', gameDate),
        supabase
            .from('weekly_lineups')
            .select('player_id, slot_type')
            .eq('member_id', memberId)
            .eq('league_id', leagueId)
            .eq('league_season_id', seasonId)
            .eq('game_date', gameDate),
    ])
    if (gamesErr) throw gamesErr
    if (existingErr) throw existingErr

    const playingTeams = new Set<string>()
    const startedTeams = new Set<string>()
    const now = new Date().toISOString()
    for (const game of (games ?? []) as GameRow[]) {
        if (game.home_team) playingTeams.add(game.home_team)
        if (game.away_team) playingTeams.add(game.away_team)
        const hasStarted =
            ['InProgress', 'Final'].includes(game.status ?? '') ||
            (game.game_time != null && game.game_time <= now)
        if (hasStarted) {
            if (game.home_team) startedTeams.add(game.home_team)
            if (game.away_team) startedTeams.add(game.away_team)
        }
    }

    const playerTeamMap = new Map(players.map((p) => [p.playerId, p.nbaTeam]))

    // Any player whose game has already started is locked — they cannot be moved in any direction.
    const lockedEntries: { playerId: string; slotType: string }[] = []
    const lockedPlayerIds = new Set<string>()
    for (const entry of (existingEntries ?? []) as WeeklyLineupRow[]) {
        const team = playerTeamMap.get(entry.player_id)
        if (team && startedTeams.has(team)) {
            lockedPlayerIds.add(entry.player_id)
            const isStarter = entry.slot_type !== 'BE' && entry.slot_type !== 'IR'
            if (isStarter) {
                lockedEntries.push({ playerId: entry.player_id, slotType: entry.slot_type })
            }
        }
    }

    const byFpts = [...players]
        .filter((p) => !lockedPlayerIds.has(p.playerId))
        .sort((a, b) => b.projected - a.projected)
    const hasGame = (p: typeof players[number]) => !!(p.nbaTeam && playingTeams.has(p.nbaTeam))

    const used = new Set<string>()
    const newAssignments: { playerId: string; slotType: string }[] = []

    // Pick the best available player for a slot:
    // 1. Best avg-fpts player WITH a game today who is eligible for the slot
    // 2. Fall back to best avg-fpts player WITHOUT a game
    function pickBest(slotType: string): string | null {
        const eligible = SLOT_ELIGIBLE[slotType] ?? []
        const pick =
            byFpts.find((p) => !used.has(p.playerId) && hasGame(p) && p.eligiblePositions.some((pos) => eligible.includes(pos))) ??
            byFpts.find((p) => !used.has(p.playerId) && p.eligiblePositions.some((pos) => eligible.includes(pos)))
        return pick?.playerId ?? null
    }

    // Fill order: pure position slots first, then flex, then UTIL
    const FILL_ORDER = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']

    const lockedSlotCounts = new Map<string, number>()
    for (const { slotType } of lockedEntries) {
        lockedSlotCounts.set(slotType, (lockedSlotCounts.get(slotType) ?? 0) + 1)
    }

    const templateMap = new Map<string, number>(
        starterTemplates.map((template) => [template.slot_type, template.slot_count]),
    )

    const slotOrder = [
        ...FILL_ORDER.filter((s) => templateMap.has(s)),
        ...([...templateMap.keys()].filter((s) => !FILL_ORDER.includes(s))),
    ]

    for (const slotType of slotOrder) {
        const totalCount = templateMap.get(slotType) ?? 0
        const alreadyFilled = lockedSlotCounts.get(slotType) ?? 0
        const remaining = totalCount - alreadyFilled
        for (let i = 0; i < remaining; i++) {
            const pid = pickBest(slotType)
            if (pid) {
                newAssignments.push({ playerId: pid, slotType })
                used.add(pid)
            }
        }
    }

    // Build the full final state of the day's lineup. The RPC replaces the
    // entire day in a single transaction, so the caller MUST include any
    // locked entries that should remain (with their original slot_type and
    // is_auto_set flag preserved). BE entries are filtered out RPC-side
    // because bench is implicit.
    const finalAssignments: LineupAssignment[] = []
    for (const { playerId, slotType } of lockedEntries) {
        finalAssignments.push({
            player_id: playerId,
            slot_type: slotType as RosterSlotType,
            is_auto_set: false,
            week_number: weekNumber,
        })
    }
    for (const { playerId, slotType } of newAssignments) {
        finalAssignments.push({
            player_id: playerId,
            slot_type: slotType as RosterSlotType,
            is_auto_set: true,
            week_number: weekNumber,
        })
    }

    // Atomic replacement under pg_advisory_xact_lock(member_id, game_date)
    // with FOR SHARE re-verification of roster ownership for every
    // player_id. Closes the race documented at the top of the migration.
    const { error } = await supabase.rpc('auto_set_lineup_atomic', {
        p_member_id: memberId,
        p_league_id: leagueId,
        p_league_season_id: seasonId,
        p_game_date: gameDate,
        p_assignments: finalAssignments,
    })
    if (error) throw error
}
