import { supabase } from '@/lib/supabase'
import type { RosterSlotType } from '@/types/database'
import { getCurrentSeason } from '@/lib/shared/season'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { canPlaySlot } from '@/constants/slots'

export { canPlaySlot, SLOT_ELIGIBLE } from '@/constants/slots'

export type LineupPlayer = {
    rosterPlayerId: string
    playerId: string
    displayName: string
    position: string | null
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
    const today = new Date().toISOString().split('T')[0]
    return { seasonId: season.id, seasonYear: season.seasonYear, weekNumber, today }
}

// Returns the 7 days of the given fantasy week with game schedule info.
export async function getWeekDays(weekNumber: number, seasonYear: number): Promise<WeekDay[]> {
    const [{ data: weekData }, { data: games }] = await Promise.all([
        supabase
            .from('season_weeks')
            .select('week_start')
            .eq('season_year', seasonYear)
            .eq('week_number', weekNumber)
            .maybeSingle(),
        supabase
            .from('nba_games')
            .select('game_date, home_team, away_team')
            .eq('season_year', seasonYear)
            .eq('week_number', weekNumber),
    ])

    const today = new Date().toISOString().split('T')[0]

    // Build date → teams map
    const dateTeams = new Map<string, string[]>()
    for (const g of games ?? []) {
        const date = (g as any).game_date as string
        if (!dateTeams.has(date)) dateTeams.set(date, [])
        const arr = dateTeams.get(date)!
        if ((g as any).home_team) arr.push((g as any).home_team)
        if ((g as any).away_team) arr.push((g as any).away_team)
    }

    const result: WeekDay[] = []

    // S M T W R F S — Thursday is 'R' to avoid collision with Tuesday
    const DAY_CHARS = ['S', 'M', 'T', 'W', 'R', 'F', 'S']

    if ((weekData as any)?.week_start) {
        const start = new Date((weekData as any).week_start + 'T12:00:00Z')
        // Snap to Monday (UTC day: 0=Sun,1=Mon,...,6=Sat)
        const dow = start.getUTCDay()
        start.setUTCDate(start.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
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
    const [{ data: templates }, { data: roster }, { data: assignments }] = await Promise.all([
        supabase
            .from('lineup_slot_templates')
            .select('slot_type, slot_count')
            .eq('league_id', leagueId),
        supabase
            .from('roster_players')
            .select('id, player_id, is_on_ir, players(display_name, position, nba_team, injury_status)')
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

    const rosterByPlayerId = new Map<string, LineupPlayer>()
    for (const r of roster ?? []) {
        const p = (r as any).players
        rosterByPlayerId.set((r as any).player_id, {
            rosterPlayerId: (r as any).id,
            playerId: (r as any).player_id,
            displayName: p?.display_name ?? '',
            position: p?.position ?? null,
            nbaTeam: p?.nba_team ?? null,
            injuryStatus: p?.injury_status ?? null,
        })
    }

    // Build starter slots from templates (excluding BE and IR)
    const starterTemplates = (templates ?? []).filter(
        (t: any) => t.slot_type !== 'BE' && t.slot_type !== 'IR',
    )

    const slotGroups: Record<string, string[]> = {}
    for (const [playerId, slotType] of assignmentMap.entries()) {
        if (slotType !== 'BE') {
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
        .filter((r: any) => !r.is_on_ir && !starterPlayerIds.has(r.player_id))
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
export async function autoSetLineup(
    memberId: string,
    leagueId: string,
    seasonId: string,
    weekNumber: number,
    seasonYear: number,
    gameDate: string | null, // null = whole week
): Promise<void> {
    const [{ data: roster }, { data: templates }] = await Promise.all([
        supabase
            .from('roster_players')
            .select('id, player_id, players(position, nba_team)')
            .eq('member_id', memberId)
            .eq('league_id', leagueId)
            .eq('league_season_id', seasonId)
            .eq('is_on_ir', false),
        supabase
            .from('lineup_slot_templates')
            .select('slot_type, slot_count')
            .eq('league_id', leagueId),
    ])

    const playerIds = (roster ?? []).map((r: any) => r.player_id)

    const { data: projections } = await supabase
        .from('player_projections')
        .select('player_id, projected_points')
        .eq('season_year', seasonYear)
        .eq('week_number', weekNumber)
        .in('player_id', playerIds)

    const projMap = new Map<string, number>(
        (projections ?? []).map((p: any) => [p.player_id, Number(p.projected_points ?? 0)]),
    )

    const players = (roster ?? []).map((r: any) => ({
        playerId: r.player_id as string,
        position: r.players?.position as string | null,
        nbaTeam: r.players?.nba_team as string | null,
        projected: projMap.get(r.player_id) ?? 0,
    }))

    const starterTemplates = (templates ?? []).filter(
        (t: any) => t.slot_type !== 'BE' && t.slot_type !== 'IR',
    )

    const dates = gameDate
        ? [gameDate]
        : (await getWeekDays(weekNumber, seasonYear)).map((d) => d.date)

    for (const date of dates) {
        await autoSetForDate(
            memberId, leagueId, seasonId, weekNumber, seasonYear,
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
    players: { playerId: string; position: string | null; nbaTeam: string | null; projected: number }[],
    starterTemplates: any[],
): Promise<void> {
    // Find which teams play on this date
    const { data: games } = await supabase
        .from('nba_games')
        .select('home_team, away_team')
        .eq('season_year', seasonYear)
        .eq('game_date', gameDate)

    const playingTeams = new Set<string>()
    for (const g of games ?? []) {
        if ((g as any).home_team) playingTeams.add((g as any).home_team)
        if ((g as any).away_team) playingTeams.add((g as any).away_team)
    }

    // Sort: players with a game today first (by projected pts), then players without
    const sorted = [...players].sort((a, b) => {
        const aHasGame = a.nbaTeam ? playingTeams.has(a.nbaTeam) : false
        const bHasGame = b.nbaTeam ? playingTeams.has(b.nbaTeam) : false
        if (aHasGame !== bHasGame) return bHasGame ? 1 : -1
        return b.projected - a.projected
    })

    // Greedy fill starter slots
    const used = new Set<string>()
    const assignments: { playerId: string; slotType: string }[] = []

    for (const t of starterTemplates) {
        for (let i = 0; i < (t as any).slot_count; i++) {
            const best = sorted.find(
                (p) => !used.has(p.playerId) && canPlaySlot(p.position, (t as any).slot_type),
            )
            if (best) {
                assignments.push({ playerId: best.playerId, slotType: (t as any).slot_type })
                used.add(best.playerId)
            }
        }
    }

    // Replace this day's lineup
    await supabase
        .from('weekly_lineups')
        .delete()
        .eq('member_id', memberId)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .eq('game_date', gameDate)

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
