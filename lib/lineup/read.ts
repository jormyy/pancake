import { supabase } from '@/lib/supabase'
import type { RosterSlotType } from '@/types/database'
import { getCurrentSeason } from '@/lib/shared/season'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { todayDateString } from '@/lib/shared/dates'
import { getEligiblePositions } from '@/lib/players'

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

    const dateTeams = new Map<string, string[]>()

    if ((weekData as any)?.week_start) {
        const start = new Date((weekData as any).week_start + 'T12:00:00Z')
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
    const isPastDate = gameDate < todayDateString()

    const [{ data: templates }, { data: roster }, { data: assignments }] = await Promise.all([
        supabase
            .from('lineup_slot_templates')
            .select('slot_type, slot_count')
            .eq('league_id', leagueId),
        supabase
            .from('roster_players')
            .select('id, player_id, is_on_ir, is_on_taxi, players(display_name, position, eligible_positions, nba_team, injury_status)')
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
    const taxiPlayerIds = new Set<string>(
        (roster ?? []).filter((r: any) => r.is_on_taxi).map((r: any) => r.player_id as string),
    )

    const rosterByPlayerId = new Map<string, LineupPlayer>()
    for (const r of roster ?? []) {
        const p = (r as any).players
        rosterByPlayerId.set((r as any).player_id, {
            rosterPlayerId: (r as any).id,
            playerId: (r as any).player_id,
            displayName: p?.display_name ?? '',
            position: p?.position ?? null,
            eligiblePositions: getEligiblePositions(p ?? {}),
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
                eligiblePositions: getEligiblePositions(p),
                nbaTeam: p.nba_team ?? null,
                injuryStatus: p.injury_status ?? null,
            })
        }

        addedAfterDate = new Set((laterAddsResult.data ?? []).map((r: any) => r.player_id as string))
    }

    const starterTemplates = (templates ?? []).filter(
        (t: any) => t.slot_type !== 'BE' && t.slot_type !== 'IR' && t.slot_type !== 'TX',
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
        .filter((r: any) => !r.is_on_ir && !r.is_on_taxi && !starterPlayerIds.has(r.player_id) && !addedAfterDate.has(r.player_id))
        .map((r: any) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    const ir: LineupPlayer[] = (roster ?? [])
        .filter((r: any) => r.is_on_ir)
        .map((r: any) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    const taxi: LineupPlayer[] = (roster ?? [])
        .filter((r: any) => r.is_on_taxi)
        .map((r: any) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    return { starters, bench, ir, taxi }
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
