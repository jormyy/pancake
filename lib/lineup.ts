import { supabase } from '@/lib/supabase'
import type { RosterSlotType } from '@/types/database'
import { getCurrentSeason } from '@/lib/shared/season'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { canPlaySlot, SLOT_ELIGIBLE } from '@/constants/slots'
import { todayDateString } from '@/lib/shared/dates'
import { isIREligible } from '@/lib/roster'

export { canPlaySlot, SLOT_ELIGIBLE } from '@/constants/slots'

// Returns the set of NBA team abbreviations whose game has already started (InProgress or Final) on the given date.
export async function getStartedTeams(gameDate: string): Promise<Set<string>> {
    const { data } = await supabase
        .from('nba_games')
        .select('home_team, away_team')
        .eq('game_date', gameDate)
        .in('status', ['InProgress', 'Final'])
    const teams = new Set<string>()
    for (const g of data ?? []) {
        if ((g as any).home_team) teams.add((g as any).home_team)
        if ((g as any).away_team) teams.add((g as any).away_team)
    }
    return teams
}

// Returns a map of team abbreviation → { opponent, isHome } for all games on the given date.
export async function getTeamMatchups(gameDate: string): Promise<Map<string, { opponent: string; isHome: boolean }>> {
    const { data } = await supabase
        .from('nba_games')
        .select('home_team, away_team')
        .eq('game_date', gameDate)
    const map = new Map<string, { opponent: string; isHome: boolean }>()
    for (const g of data ?? []) {
        const home = (g as any).home_team
        const away = (g as any).away_team
        if (home && away) {
            map.set(home, { opponent: away, isHome: true })
            map.set(away, { opponent: home, isHome: false })
        }
    }
    return map
}

// Returns the set of NBA team abbreviations with a game currently InProgress on the given date.
export async function getLiveTeams(gameDate: string): Promise<Set<string>> {
    const { data } = await supabase
        .from('nba_games')
        .select('home_team, away_team')
        .eq('game_date', gameDate)
        .eq('status', 'InProgress')
    const teams = new Set<string>()
    for (const g of data ?? []) {
        if ((g as any).home_team) teams.add((g as any).home_team)
        if ((g as any).away_team) teams.add((g as any).away_team)
    }
    return teams
}

export type LineupPlayer = {
    rosterPlayerId: string
    playerId: string
    displayName: string
    position: string | null
    eligiblePositions: string[]
    nbaTeam: string | null
    injuryStatus: string | null
}

export type LineupSlot = {
    slotType: string
    player: LineupPlayer | null
}

export type LineupContext = {
    seasonId: string
    seasonYear: number
    weekNumber: number
    today: string // 'YYYY-MM-DD'
}

export type WeekDay = {
    date: string         // 'YYYY-MM-DD'
    dayLabel: string     // 'Mon', 'Tue', …
    dateNum: number      // day of month
    hasGames: boolean    // any NBA games scheduled
    isToday: boolean
    playingTeams: string[]
}

export async function getLineupContext(leagueId: string): Promise<LineupContext | null> {
    const season = await getCurrentSeason(leagueId)
    if (!season) return null
    const weekNumber = await getCurrentWeekNumber(season.seasonYear) ?? 1
    const today = todayDateString()
    return { seasonId: season.id, seasonYear: season.seasonYear, weekNumber, today }
}

// Returns the 7 days of the given fantasy week with game schedule info.
export async function getWeekDays(weekNumber: number, seasonYear: number): Promise<WeekDay[]> {
    // Fetch week boundaries first, then query games by date range.
    // Querying by week_number on nba_games is unreliable — rows can have stale/incorrect
    // week_number values if the schedule was synced out of order or re-seeded.
    const { data: weekData } = await supabase
        .from('season_weeks')
        .select('week_start')
        .eq('season_year', seasonYear)
        .eq('week_number', weekNumber)
        .maybeSingle()

    const today = todayDateString()
    const DAY_CHARS = ['S', 'M', 'T', 'W', 'R', 'F', 'S']
    const result: WeekDay[] = []

    // Build date → teams map from a date-range query when we have week_start
    const dateTeams = new Map<string, string[]>()

    if ((weekData as any)?.week_start) {
        const start = new Date((weekData as any).week_start + 'T12:00:00Z')
        // Snap to Monday
        const dow = start.getUTCDay()
        start.setUTCDate(start.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
        const end = new Date(start)
        end.setUTCDate(end.getUTCDate() + 6)
        const startStr = start.toISOString().split('T')[0]
        const endStr = end.toISOString().split('T')[0]

        const { data: games } = await supabase
            .from('nba_games')
            .select('game_date, home_team, away_team')
            .eq('season_year', seasonYear)
            .gte('game_date', startStr)
            .lte('game_date', endStr)

        for (const g of games ?? []) {
            const date = (g as any).game_date as string
            if (!dateTeams.has(date)) dateTeams.set(date, [])
            const arr = dateTeams.get(date)!
            if ((g as any).home_team) arr.push((g as any).home_team)
            if ((g as any).away_team) arr.push((g as any).away_team)
        }

        for (let i = 0; i < 7; i++) {
            const d = new Date(start)
            d.setUTCDate(d.getUTCDate() + i)
            const dateStr = d.toISOString().split('T')[0]
            result.push({
                date: dateStr,
                dayLabel: DAY_CHARS[d.getUTCDay()],
                dateNum: d.getUTCDate(),
                hasGames: dateTeams.has(dateStr),
                isToday: dateStr === today,
                playingTeams: dateTeams.get(dateStr) ?? [],
            })
        }
    } else {
        // Fallback: week_start unknown — fall back to week_number query
        const { data: games } = await supabase
            .from('nba_games')
            .select('game_date, home_team, away_team')
            .eq('season_year', seasonYear)
            .eq('week_number', weekNumber)

        for (const g of games ?? []) {
            const date = (g as any).game_date as string
            if (!dateTeams.has(date)) dateTeams.set(date, [])
            const arr = dateTeams.get(date)!
            if ((g as any).home_team) arr.push((g as any).home_team)
            if ((g as any).away_team) arr.push((g as any).away_team)
        }
        // Fallback: use distinct game dates from this week
        const uniqueDates = [...new Set([...dateTeams.keys()])].sort()
        for (const dateStr of uniqueDates) {
            const d = new Date(dateStr + 'T12:00:00Z')
            result.push({
                date: dateStr,
                dayLabel: DAY_CHARS[d.getUTCDay()],
                dateNum: d.getUTCDate(),
                hasGames: true,
                isToday: dateStr === today,
                playingTeams: dateTeams.get(dateStr) ?? [],
            })
        }
    }

    return result
}

export async function getWeeklyLineup(
    memberId: string,
    leagueId: string,
    seasonId: string,
    weekNumber: number,
    gameDate: string,
): Promise<{ starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[] }> {
    const isPastDate = gameDate < todayDateString()

    const [{ data: templates }, { data: roster }, { data: assignments }] = await Promise.all([
        supabase
            .from('lineup_slot_templates')
            .select('slot_type, slot_count')
            .eq('league_id', leagueId),
        supabase
            .from('roster_players')
            .select('id, player_id, is_on_ir, players(display_name, position, eligible_positions, nba_team, injury_status)')
            .eq('member_id', memberId)
            .eq('league_id', leagueId)
            .eq('league_season_id', seasonId),
        supabase
            .from('weekly_lineups')
            .select('player_id, slot_type')
            .eq('member_id', memberId)
            .eq('league_id', leagueId)
            .eq('league_season_id', seasonId)
            .eq('game_date', gameDate),
    ])

    const assignmentMap = new Map<string, string>(
        (assignments ?? []).map((a: any) => [a.player_id, a.slot_type]),
    )

    const irPlayerIds = new Set<string>(
        (roster ?? []).filter((r: any) => r.is_on_ir).map((r: any) => r.player_id as string),
    )

    const rosterByPlayerId = new Map<string, LineupPlayer>()
    for (const r of roster ?? []) {
        const p = (r as any).players
        rosterByPlayerId.set((r as any).player_id, {
            rosterPlayerId: (r as any).id,
            playerId: (r as any).player_id,
            displayName: p?.display_name ?? '',
            position: p?.position ?? null,
            eligiblePositions: p?.eligible_positions?.length ? p.eligible_positions : (p?.position ? [p.position] : []),
            nbaTeam: p?.nba_team ?? null,
            injuryStatus: p?.injury_status ?? null,
        })
    }

    // For past dates: players may have been dropped since that day. Fetch their player
    // data directly so their starter slots still render correctly. Also find which current
    // roster players were added AFTER this date so they're excluded from bench.
    let addedAfterDate = new Set<string>()
    if (isPastDate) {
        const missingPlayerIds = [...assignmentMap.keys()].filter((pid) => !rosterByPlayerId.has(pid))
        const [extraPlayersResult, laterAddsResult] = await Promise.all([
            missingPlayerIds.length > 0
                ? supabase
                    .from('players')
                    .select('id, display_name, position, eligible_positions, nba_team, injury_status')
                    .in('id', missingPlayerIds)
                : Promise.resolve({ data: [] }),
            (supabase as any)
                .from('roster_transactions')
                .select('player_id')
                .eq('member_id', memberId)
                .eq('league_id', leagueId)
                .eq('league_season_id', seasonId)
                .in('transaction_type', ['fa_add', 'waiver_add', 'trade_in', 'draft_won'])
                .gt('occurred_at', gameDate + 'T23:59:59Z'),
        ])

        for (const p of (extraPlayersResult.data ?? []) as any[]) {
            rosterByPlayerId.set(p.id, {
                rosterPlayerId: '',
                playerId: p.id,
                displayName: p.display_name ?? '',
                position: p.position ?? null,
                eligiblePositions: p.eligible_positions?.length ? p.eligible_positions : (p.position ? [p.position] : []),
                nbaTeam: p.nba_team ?? null,
                injuryStatus: p.injury_status ?? null,
            })
        }

        addedAfterDate = new Set((laterAddsResult.data ?? []).map((r: any) => r.player_id as string))
    }

    // Build starter slots from templates (excluding BE and IR)
    const starterTemplates = (templates ?? []).filter(
        (t: any) => t.slot_type !== 'BE' && t.slot_type !== 'IR',
    )

    const slotGroups: Record<string, string[]> = {}
    for (const [playerId, slotType] of assignmentMap.entries()) {
        // Skip IR players — they shouldn't fill starter slots even if a stale lineup entry exists
        if (slotType !== 'BE' && !irPlayerIds.has(playerId)) {
            if (!slotGroups[slotType]) slotGroups[slotType] = []
            slotGroups[slotType].push(playerId)
        }
    }

    const starters: LineupSlot[] = []
    for (const t of starterTemplates) {
        const assigned = slotGroups[(t as any).slot_type] ?? []
        for (let i = 0; i < (t as any).slot_count; i++) {
            const pid = assigned[i] ?? null
            starters.push({
                slotType: (t as any).slot_type,
                player: pid ? (rosterByPlayerId.get(pid) ?? null) : null,
            })
        }
    }

    const starterPlayerIds = new Set(
        starters.map((s) => s.player?.playerId).filter(Boolean) as string[],
    )
    const bench: LineupPlayer[] = (roster ?? [])
        .filter((r: any) => !r.is_on_ir && !starterPlayerIds.has(r.player_id) && !addedAfterDate.has(r.player_id))
        .map((r: any) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    const ir: LineupPlayer[] = (roster ?? [])
        .filter((r: any) => r.is_on_ir)
        .map((r: any) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    return { starters, bench, ir }
}

export async function setPlayerSlot(
    memberId: string,
    leagueId: string,
    seasonId: string,
    weekNumber: number,
    gameDate: string,
    playerId: string,
    slotType: string,
): Promise<void> {
    if (slotType === 'BE') {
        await supabase
            .from('weekly_lineups')
            .delete()
            .eq('member_id', memberId)
            .eq('league_id', leagueId)
            .eq('league_season_id', seasonId)
            .eq('player_id', playerId)
            .eq('game_date', gameDate)
    } else {
        const { error } = await supabase.from('weekly_lineups').upsert(
            {
                member_id: memberId,
                league_id: leagueId,
                league_season_id: seasonId,
                player_id: playerId,
                week_number: weekNumber,
                game_date: gameDate,
                slot_type: slotType as RosterSlotType,
                is_auto_set: false,
                set_at: new Date().toISOString(),
            },
            { onConflict: 'league_id,league_season_id,member_id,player_id,game_date' },
        )
        if (error) throw error
    }
}

// Auto-set lineup for a single day or the full week.
// For each day: players who have an NBA game that day are prioritized as starters,
// then filled in by projected points. Players without games land on bench.
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
            eligiblePositions: (r.players?.eligible_positions as string[] | null)?.length
                ? (r.players.eligible_positions as string[])
                : (r.players?.position ? [r.players.position as string] : []),
            nbaTeam: r.players?.nba_team as string | null,
            projected: injured ? 0 : (avgFptsMap.get(r.player_id) ?? 0),
        }
    })

    const starterTemplates = (templates ?? []).filter(
        (t: any) => t.slot_type !== 'BE' && t.slot_type !== 'IR',
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

    // Find which teams play on this date and which have already started/finished
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

    // Build a map of playerId → team for quick lookup
    const playerTeamMap = new Map(players.map((p) => [p.playerId, p.nbaTeam]))

    // Any player whose game has already started is locked — they cannot be moved in any direction.
    // This covers both locked starters (preserve their slot) and locked bench players (can't promote them).
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

    // Players sorted by avg fpts descending. Game-day players are preferred within each slot
    // but the fundamental ranking is always avg fpts.
    const byFpts = [...players]
        .filter((p) => !lockedPlayerIds.has(p.playerId))
        .sort((a, b) => b.projected - a.projected)
    const hasGame = (p: typeof players[number]) => !!(p.nbaTeam && playingTeams.has(p.nbaTeam))

    const used = new Set<string>()
    const assignments: { playerId: string; slotType: string }[] = []

    // Pick the best available player for a slot:
    // 1. Best avg-fpts player WITH a game today who is eligible for the slot
    // 2. Fall back to best avg-fpts player WITHOUT a game (leaves slot non-zero only if needed)
    function pickBest(slotType: string): string | null {
        const eligible = SLOT_ELIGIBLE[slotType] ?? []
        const pick =
            byFpts.find((p) => !used.has(p.playerId) && hasGame(p) && p.eligiblePositions.some((pos) => eligible.includes(pos))) ??
            byFpts.find((p) => !used.has(p.playerId) && p.eligiblePositions.some((pos) => eligible.includes(pos)))
        return pick?.playerId ?? null
    }

    // Fill order mirrors the user-described priority:
    // Phase 1 — pure position slots (PG, SG, SF, PF, C): best player AT that position
    // Phase 2 — flex slots (G, F): best remaining player eligible for that slot
    // Phase 3 — UTIL: best remaining players regardless of position
    // Any slot type not in this list (shouldn't happen) is appended last.
    const FILL_ORDER = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']

    // Count how many slots are already filled by locked players per slot type
    const lockedSlotCounts = new Map<string, number>()
    for (const { slotType } of lockedEntries) {
        lockedSlotCounts.set(slotType, (lockedSlotCounts.get(slotType) ?? 0) + 1)
    }

    const templateMap = new Map<string, number>(
        starterTemplates.map((t: any) => [t.slot_type as string, t.slot_count as number]),
    )

    // Fill in explicit order so G/F are always resolved after their pure-position counterparts,
    // and UTIL gets whatever high-value players remain.
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
        // Delete all non-locked entries for this day
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
        // No locked players — safe to wipe and replace entirely
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
