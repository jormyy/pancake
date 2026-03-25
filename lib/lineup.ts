import { supabase } from '@/lib/supabase'

// Which player positions are eligible for each slot type
export const SLOT_ELIGIBLE: Record<string, string[]> = {
    PG: ['PG'],
    SG: ['SG'],
    SF: ['SF'],
    PF: ['PF'],
    C: ['C'],
    G: ['PG', 'SG'],
    F: ['SF', 'PF'],
    UTIL: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
    BE: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
}

export function canPlaySlot(position: string | null, slotType: string): boolean {
    if (!position || slotType === 'IR') return false
    return SLOT_ELIGIBLE[slotType]?.includes(position) ?? false
}

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
}

async function getCurrentSeason(leagueId: string) {
    const { data } = await supabase
        .from('league_seasons')
        .select('id, season_year')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()
    return data ? { id: data.id, seasonYear: data.season_year } : null
}

async function getCurrentWeekNumber(seasonYear: number): Promise<number> {
    const today = new Date().toISOString().split('T')[0]
    const { data } = await supabase
        .from('nba_games')
        .select('week_number')
        .eq('season_year', seasonYear)
        .lte('game_date', today)
        .order('game_date', { ascending: false })
        .limit(1)
        .maybeSingle()
    return data?.week_number ?? 1
}

export async function getLineupContext(leagueId: string): Promise<LineupContext | null> {
    const season = await getCurrentSeason(leagueId)
    if (!season) return null
    const weekNumber = await getCurrentWeekNumber(season.seasonYear)
    return { seasonId: season.id, seasonYear: season.seasonYear, weekNumber }
}

export async function getWeeklyLineup(
    memberId: string,
    leagueId: string,
    seasonId: string,
    weekNumber: number,
): Promise<{ starters: LineupSlot[]; bench: LineupPlayer[] }> {
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
            .eq('week_number', weekNumber),
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

    // Bench = active roster players not assigned to any starter slot
    const starterPlayerIds = new Set(
        starters.map((s) => s.player?.playerId).filter(Boolean) as string[],
    )
    const bench: LineupPlayer[] = (roster ?? [])
        .filter((r: any) => !r.is_on_ir && !starterPlayerIds.has(r.player_id))
        .map((r: any) => rosterByPlayerId.get(r.player_id)!)
        .filter(Boolean)

    return { starters, bench }
}

export async function setPlayerSlot(
    memberId: string,
    leagueId: string,
    seasonId: string,
    weekNumber: number,
    playerId: string,
    slotType: string,
): Promise<void> {
    if (slotType === 'BE') {
        // Benching: remove the lineup entry so the player is implicitly on bench
        await supabase
            .from('weekly_lineups')
            .delete()
            .eq('member_id', memberId)
            .eq('league_id', leagueId)
            .eq('league_season_id', seasonId)
            .eq('player_id', playerId)
            .eq('week_number', weekNumber)
    } else {
        const { error } = await supabase.from('weekly_lineups').upsert(
            {
                member_id: memberId,
                league_id: leagueId,
                league_season_id: seasonId,
                player_id: playerId,
                week_number: weekNumber,
                slot_type: slotType,
                is_auto_set: false,
                set_at: new Date().toISOString(),
            },
            { onConflict: 'league_id,league_season_id,member_id,player_id,week_number' },
        )
        if (error) throw error
    }
}

export async function autoSetLineup(
    memberId: string,
    leagueId: string,
    seasonId: string,
    weekNumber: number,
    seasonYear: number,
): Promise<void> {
    const { data: roster } = await supabase
        .from('roster_players')
        .select('id, player_id, players(position)')
        .eq('member_id', memberId)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .eq('is_on_ir', false)

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

    const players = (roster ?? [])
        .map((r: any) => ({
            playerId: r.player_id as string,
            position: r.players?.position as string | null,
            projected: projMap.get(r.player_id) ?? 0,
        }))
        .sort((a, b) => b.projected - a.projected)

    const { data: templates } = await supabase
        .from('lineup_slot_templates')
        .select('slot_type, slot_count')
        .eq('league_id', leagueId)

    const starterTemplates = (templates ?? []).filter(
        (t: any) => t.slot_type !== 'BE' && t.slot_type !== 'IR',
    )

    // Greedy fill: best available eligible player for each slot
    const used = new Set<string>()
    const assignments: { playerId: string; slotType: string }[] = []

    for (const t of starterTemplates) {
        for (let i = 0; i < (t as any).slot_count; i++) {
            const best = players.find(
                (p) => !used.has(p.playerId) && canPlaySlot(p.position, (t as any).slot_type),
            )
            if (best) {
                assignments.push({ playerId: best.playerId, slotType: (t as any).slot_type })
                used.add(best.playerId)
            }
        }
    }

    // Replace lineup for this week
    await supabase
        .from('weekly_lineups')
        .delete()
        .eq('member_id', memberId)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .eq('week_number', weekNumber)

    if (assignments.length > 0) {
        const { error } = await supabase.from('weekly_lineups').insert(
            assignments.map(({ playerId, slotType }) => ({
                member_id: memberId,
                league_id: leagueId,
                league_season_id: seasonId,
                player_id: playerId,
                week_number: weekNumber,
                slot_type: slotType,
                is_auto_set: true,
                set_at: new Date().toISOString(),
            })),
        )
        if (error) throw error
    }
}
