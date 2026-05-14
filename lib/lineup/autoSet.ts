import { supabase } from '@/lib/supabase'
import type { RosterSlotType } from '@/types/database'
import { canPlaySlot, SLOT_ELIGIBLE } from '@/constants/slots'
import { todayDateString } from '@/lib/shared/dates'
import { isIREligible } from '@/lib/roster'
import { getEligiblePositions } from '@/lib/players'
import { getWeekDays } from './read'

async function getRemainingSeasonDates(
    fromWeek: number,
    seasonYear: number,
): Promise<{ date: string; weekNumber: number }[]> {
    const today = todayDateString()
    const { data: weeks } = await supabase
        .from('season_weeks')
        .select('week_number, week_start')
        .eq('season_year', seasonYear)
        .gte('week_number', fromWeek)
        .order('week_number', { ascending: true })

    const result: { date: string; weekNumber: number }[] = []
    for (const w of weeks ?? []) {
        const start = new Date((w as any).week_start + 'T12:00:00Z')
        const dow = start.getUTCDay()
        start.setUTCDate(start.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
        for (let i = 0; i < 7; i++) {
            const d = new Date(start)
            d.setUTCDate(d.getUTCDate() + i)
            const dateStr = d.toISOString().split('T')[0]
            if (dateStr >= today) {
                result.push({ date: dateStr, weekNumber: (w as any).week_number })
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
    const [{ data: roster }, { data: templates }] = await Promise.all([
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

    const playerIds = (roster ?? []).map((r: any) => r.player_id)

    // Use mv_player_season_averages (1 row per player, already excludes did_not_play games)
    // instead of querying raw player_game_stats. The raw query has no explicit limit and
    // Supabase truncates at 1000 rows — with 15+ players × 70+ games each, some players'
    // stats get silently dropped, giving them projected = 0 and leaving them on bench.
    const [{ data: avgRows }, { data: leagueRow }] = await Promise.all([
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

    const s = (leagueRow as any)?.scoring_settings ?? {}
    const val = (key: string) => Number(s[key] ?? 0)

    const avgFptsMap = new Map<string, number>()
    for (const row of avgRows ?? []) {
        const r = row as any
        const gp = Number(r.games_played) || 0
        const fpts =
            Number(r.avg_points ?? 0)                * val('points') +
            Number(r.avg_rebounds ?? 0)              * val('rebounds') +
            Number(r.avg_assists ?? 0)               * val('assists') +
            Number(r.avg_steals ?? 0)                * val('steals') +
            Number(r.avg_blocks ?? 0)                * val('blocks') +
            Number(r.avg_turnovers ?? 0)             * val('turnovers') +
            Number(r.avg_three_pointers_made ?? 0)   * val('three_pointers_made') +
            Number(r.avg_field_goals_made ?? 0)      * val('field_goals_made') +
            Number(r.avg_field_goals_attempted ?? 0) * val('field_goals_attempted') +
            Number(r.avg_free_throws_made ?? 0)      * val('free_throws_made') +
            Number(r.avg_free_throws_attempted ?? 0) * val('free_throws_attempted') +
            (gp > 0 ? (Number(r.double_doubles ?? 0) / gp) * val('double_double') : 0) +
            (gp > 0 ? (Number(r.triple_doubles ?? 0) / gp) * val('triple_double') : 0)
        avgFptsMap.set(r.player_id, fpts)
    }

    const players = (roster ?? []).map((r: any) => {
        const injured = isIREligible(r.players?.injury_status ?? null)
        return {
            playerId: r.player_id as string,
            eligiblePositions: getEligiblePositions(r.players ?? {}),
            nbaTeam: r.players?.nba_team as string | null,
            projected: injured ? 0 : (avgFptsMap.get(r.player_id) ?? 0),
        }
    })

    const starterTemplates = (templates ?? []).filter(
        (t: any) => t.slot_type !== 'BE' && t.slot_type !== 'IR' && t.slot_type !== 'TX',
    )

    const today = todayDateString()
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

    for (const { date, weekNumber: wn } of datesToProcess) {
        await autoSetForDate(
            memberId, leagueId, seasonId, wn, seasonYear,
            date, players, starterTemplates,
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
    players: { playerId: string; eligiblePositions: string[]; nbaTeam: string | null; projected: number }[],
    starterTemplates: any[],
): Promise<void> {
    // Skip past dates - lineups for already-played games should remain locked
    if (gameDate < todayDateString()) return

    const [{ data: games }, { data: existingEntries }] = await Promise.all([
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

    const playingTeams = new Set<string>()
    const startedTeams = new Set<string>()
    const now = new Date().toISOString()
    for (const g of games ?? []) {
        if ((g as any).home_team) playingTeams.add((g as any).home_team)
        if ((g as any).away_team) playingTeams.add((g as any).away_team)
        const hasStarted =
            ['InProgress', 'Final'].includes((g as any).status) ||
            ((g as any).game_time && (g as any).game_time <= now)
        if (hasStarted) {
            if ((g as any).home_team) startedTeams.add((g as any).home_team)
            if ((g as any).away_team) startedTeams.add((g as any).away_team)
        }
    }

    const playerTeamMap = new Map(players.map((p) => [p.playerId, p.nbaTeam]))

    // Any player whose game has already started is locked — they cannot be moved in any direction.
    const lockedEntries: { playerId: string; slotType: string }[] = []
    const lockedPlayerIds = new Set<string>()
    for (const entry of existingEntries ?? []) {
        const team = playerTeamMap.get((entry as any).player_id)
        if (team && startedTeams.has(team)) {
            lockedPlayerIds.add((entry as any).player_id)
            const isStarter = (entry as any).slot_type !== 'BE' && (entry as any).slot_type !== 'IR'
            if (isStarter) {
                lockedEntries.push({ playerId: (entry as any).player_id, slotType: (entry as any).slot_type })
            }
        }
    }

    const byFpts = [...players]
        .filter((p) => !lockedPlayerIds.has(p.playerId))
        .sort((a, b) => b.projected - a.projected)
    const hasGame = (p: typeof players[number]) => !!(p.nbaTeam && playingTeams.has(p.nbaTeam))

    const used = new Set<string>()
    const assignments: { playerId: string; slotType: string }[] = []

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
        starterTemplates.map((t: any) => [t.slot_type as string, t.slot_count as number]),
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
                assignments.push({ playerId: pid, slotType })
                used.add(pid)
            }
        }
    }

    // Delete only unlocked entries, preserving locked starters
    if (lockedPlayerIds.size > 0) {
        const unlockedEntryPlayerIds = (existingEntries ?? [])
            .map((e: any) => e.player_id)
            .filter((pid: string) => !lockedPlayerIds.has(pid))
        if (unlockedEntryPlayerIds.length > 0) {
            await supabase
                .from('weekly_lineups')
                .delete()
                .eq('member_id', memberId)
                .eq('league_id', leagueId)
                .eq('league_season_id', seasonId)
                .eq('game_date', gameDate)
                .in('player_id', unlockedEntryPlayerIds)
        }
    } else {
        await supabase
            .from('weekly_lineups')
            .delete()
            .eq('member_id', memberId)
            .eq('league_id', leagueId)
            .eq('league_season_id', seasonId)
            .eq('game_date', gameDate)
    }

    if (assignments.length > 0) {
        const { error } = await supabase.from('weekly_lineups').insert(
            assignments.map(({ playerId, slotType }) => ({
                member_id: memberId,
                league_id: leagueId,
                league_season_id: seasonId,
                player_id: playerId,
                week_number: weekNumber,
                game_date: gameDate,
                slot_type: slotType as RosterSlotType,
                is_auto_set: true,
                set_at: new Date().toISOString(),
            })),
        )
        if (error) throw error
    }
}
