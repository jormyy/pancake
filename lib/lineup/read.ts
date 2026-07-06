import { supabase } from '@/lib/supabase'
import type { Database, RosterSlotType } from '@/types/database'
import { getCurrentSeason } from '@/lib/shared/season'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { endOfETDayUTC, todayET } from '@/lib/shared/dates'
import { getEligiblePositions } from '@/lib/players'

type PlayerRow = Database['public']['Tables']['players']['Row']

export type LineupPlayer = {
    rosterPlayerId: string
    playerId: string
    displayName: string
    position: string | null
    eligiblePositions: string[]
    nbaTeam: string | null
    injuryStatus: string | null
    nbaId: string | null
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

/**
 * Default day for a week view: today when it falls inside the week, otherwise
 * the nearest edge of the week. Without the clamp, viewing a week that does
 * not contain today (offseason, pre-season, catching up on a past week)
 * selects a date with no lineup rows and every slot renders as an em-dash.
 */
export function clampDateToWeek(date: string, days: WeekDay[]): string {
    if (days.length === 0) return date
    if (date < days[0].date) return days[0].date
    const last = days[days.length - 1].date
    if (date > last) return last
    return date
}

// Returns the set of NBA team abbreviations whose game has already started on the given date.
export async function getStartedTeams(gameDate: string): Promise<Set<string>> {
    const { data } = await supabase
        .from('nba_games')
        .select('home_team, away_team, status, game_time')
        .eq('game_date', gameDate)
    const teams = new Set<string>()
    const now = new Date().toISOString()
    for (const g of data ?? []) {
        const hasStarted =
            ['InProgress', 'Final'].includes(g.status ?? '') ||
            (g.game_time != null && g.game_time <= now)
        if (!hasStarted) continue
        if (g.home_team) teams.add(g.home_team)
        if (g.away_team) teams.add(g.away_team)
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
        const home = g.home_team
        const away = g.away_team
        if (home && away) {
            map.set(home, { opponent: away, isHome: true })
            map.set(away, { opponent: home, isHome: false })
        }
    }
    return map
}

export async function getLineupContext(leagueId: string): Promise<LineupContext | null> {
    const season = await getCurrentSeason(leagueId)
    if (!season) return null
    const weekNumber = await getCurrentWeekNumber(season.seasonYear) ?? 1
    // `today` flows through to queries comparing against nba_games.game_date /
    // weekly_lineups.game_date — both stored in ET. Use ET here so non-ET
    // clients select the correct slate during the 0–3h skew.
    const today = todayET()
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

    const today = todayET()
    const DAY_CHARS = ['S', 'M', 'T', 'W', 'R', 'F', 'S']
    const result: WeekDay[] = []

    const dateTeams = new Map<string, string[]>()

    if (weekData?.week_start) {
        const start = new Date(weekData.week_start + 'T12:00:00Z')
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
            const date = g.game_date
            if (!dateTeams.has(date)) dateTeams.set(date, [])
            const arr = dateTeams.get(date)!
            if (g.home_team) arr.push(g.home_team)
            if (g.away_team) arr.push(g.away_team)
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
            const date = g.game_date
            if (!dateTeams.has(date)) dateTeams.set(date, [])
            const arr = dateTeams.get(date)!
            if (g.home_team) arr.push(g.home_team)
            if (g.away_team) arr.push(g.away_team)
        }
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
): Promise<{ starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] }> {
    // gameDate is a YYYY-MM-DD string aligned to nba_games.game_date (ET).
    // Compare against todayET so non-ET clients don't misclassify the current
    // slate as "past" (or vice versa) during the 0–3h skew.
    const isPastDate = gameDate < todayET()

    const [{ data: templates }, { data: roster }, { data: assignments }] = await Promise.all([
        supabase
            .from('lineup_slot_templates')
            .select('slot_type, slot_count')
            .eq('league_id', leagueId),
        supabase
            .from('roster_players')
            .select('id, player_id, is_on_ir, is_on_taxi, players(display_name, position, eligible_positions, nba_team, injury_status, nba_id)')
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
        (assignments ?? []).map((a) => [a.player_id, a.slot_type]),
    )

    const irPlayerIds = new Set<string>(
        (roster ?? []).filter((r) => r.is_on_ir).map((r) => r.player_id),
    )
    const taxiPlayerIds = new Set<string>(
        (roster ?? []).filter((r) => r.is_on_taxi).map((r) => r.player_id),
    )

    const rosterByPlayerId = new Map<string, LineupPlayer>()
    for (const r of roster ?? []) {
        // Supabase types `players` as a possible array | object | null depending on relationship inference.
        // The join is one-to-one, so we normalize to a single record.
        const playersRel = r.players
        const p = Array.isArray(playersRel) ? (playersRel[0] ?? null) : playersRel
        rosterByPlayerId.set(r.player_id, {
            rosterPlayerId: r.id,
            playerId: r.player_id,
            displayName: p?.display_name ?? '',
            position: p?.position ?? null,
            eligiblePositions: getEligiblePositions(p ?? {}),
            nbaTeam: p?.nba_team ?? null,
            injuryStatus: p?.injury_status ?? null,
            nbaId: p?.nba_id ?? null,
        })
    }

    // For past dates: players may have been dropped since that day. Fetch their player
    // data directly so their starter slots still render correctly. Also find which current
    // roster players were added AFTER this date so they're excluded from bench.
    let addedAfterDate = new Set<string>()
    if (isPastDate) {
        const missingPlayerIds = [...assignmentMap.keys()].filter((pid) => !rosterByPlayerId.has(pid))
        type ExtraPlayer = Pick<PlayerRow, 'id' | 'display_name' | 'position' | 'eligible_positions' | 'nba_team' | 'injury_status' | 'nba_id'>
        const [extraPlayersResult, laterAddsResult] = await Promise.all([
            missingPlayerIds.length > 0
                ? supabase
                    .from('players')
                    .select('id, display_name, position, eligible_positions, nba_team, injury_status, nba_id')
                    .in('id', missingPlayerIds)
                : Promise.resolve({ data: [] as ExtraPlayer[] }),
            supabase
                .from('roster_transactions')
                .select('player_id')
                .eq('member_id', memberId)
                .eq('league_id', leagueId)
                .eq('league_season_id', seasonId)
                .in('transaction_type', ['fa_add', 'waiver_add', 'trade_in', 'draft_won', 'carry_over'])
                // gameDate is ET-keyed (YYYY-MM-DD). Use exact next local midnight
                // so DST does not shift post-slate transaction history by an hour.
                .gt('occurred_at', endOfETDayUTC(gameDate)),
        ])

        for (const p of extraPlayersResult.data ?? []) {
            rosterByPlayerId.set(p.id, {
                rosterPlayerId: '',
                playerId: p.id,
                displayName: p.display_name ?? '',
                position: p.position ?? null,
                eligiblePositions: getEligiblePositions(p),
                nbaTeam: p.nba_team ?? null,
                injuryStatus: p.injury_status ?? null,
                nbaId: p.nba_id ?? null,
            })
        }

        addedAfterDate = new Set((laterAddsResult.data ?? []).map((r) => r.player_id))
    }

    // Taxi slots are tracked via `roster_players.is_on_taxi`, not as a slot template type,
    // so the enum doesn't include 'TX'. Only BE/IR are excluded here.
    const starterTemplates = (templates ?? []).filter(
        (t) => t.slot_type !== 'BE' && t.slot_type !== 'IR',
    )

    const slotGroups: Record<string, string[]> = {}
    for (const [playerId, slotType] of assignmentMap.entries()) {
        if (slotType !== 'BE' && !irPlayerIds.has(playerId) && !taxiPlayerIds.has(playerId)) {
            if (!slotGroups[slotType]) slotGroups[slotType] = []
            slotGroups[slotType].push(playerId)
        }
    }

    const starters: LineupSlot[] = []
    for (const t of starterTemplates) {
        const assigned = slotGroups[t.slot_type] ?? []
        for (let i = 0; i < t.slot_count; i++) {
            const pid = assigned[i] ?? null
            starters.push({
                slotType: t.slot_type,
                player: pid ? (rosterByPlayerId.get(pid) ?? null) : null,
            })
        }
    }

    const starterPlayerIds = new Set(
        starters.map((s) => s.player?.playerId).filter(Boolean) as string[],
    )
    const bench: LineupPlayer[] = (roster ?? [])
        .filter((r) => !r.is_on_ir && !r.is_on_taxi && !starterPlayerIds.has(r.player_id) && !addedAfterDate.has(r.player_id))
        .map((r) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    const ir: LineupPlayer[] = (roster ?? [])
        .filter((r) => r.is_on_ir)
        .map((r) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    const taxi: LineupPlayer[] = (roster ?? [])
        .filter((r) => r.is_on_taxi)
        .map((r) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    return { starters, bench, ir, taxi }
}

export type LineupSlotMove = {
    playerId: string
    slotType: string
}

export async function setPlayerSlotMoves(
    {
        memberId,
        leagueId,
        seasonId,
        weekNumber,
        gameDate,
    }: {
        memberId: string
        leagueId: string
        seasonId: string
        weekNumber: number
        gameDate: string
    },
    moves: LineupSlotMove[],
): Promise<void> {
    if (moves.length === 0) return
    const { error } = await supabase.rpc('set_player_slot_moves_atomic', {
        p_member_id: memberId,
        p_league_id: leagueId,
        p_league_season_id: seasonId,
        p_game_date: gameDate,
        p_week_number: weekNumber,
        p_moves: moves.map((move) => ({
            player_id: move.playerId,
            slot_type: move.slotType as RosterSlotType,
        })),
    })
    if (error) throw error
}
