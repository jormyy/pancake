import { supabase } from '@/lib/supabase'
import { getCurrentSeason } from '@/lib/shared/season'
import type { OwnedEntry } from '@/lib/roster'

export type PlayerAvailabilitySnapshot = {
    ownedMap: Map<string, OwnedEntry>
    waiverIds: Set<string>
}

type OwnedPlayerRow = {
    player_id: string
    member_id: string
    league_members: { team_name: string | null } | null
}

type WaiverPlayerIdRow = { player_id: string }

async function getLatestSeasonId(leagueId: string): Promise<string | null> {
    const { data, error } = await supabase
        .from('league_seasons')
        .select('id')
        .eq('league_id', leagueId)
        .order('season_year', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) throw error
    return data?.id ?? null
}

export async function getPlayerAvailabilitySnapshot(leagueId: string): Promise<PlayerAvailabilitySnapshot> {
    const currentSeason = await getCurrentSeason(leagueId)
    const seasonId = currentSeason?.id ?? await getLatestSeasonId(leagueId)
    if (!seasonId) return { ownedMap: new Map(), waiverIds: new Set() }

    const rosterQuery = supabase
        .from('roster_players')
        .select('player_id, member_id, league_members(team_name)')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)

    const waiverQuery = currentSeason
        ? supabase
            .from('waiver_wire_log')
            .select('player_id')
            .eq('league_id', leagueId)
            .eq('league_season_id', currentSeason.id)
            .is('cleared_at', null)
            .gt('clears_at', new Date().toISOString())
        : Promise.resolve({ data: [] as WaiverPlayerIdRow[], error: null })

    const [{ data: rosterRows, error: rosterError }, { data: waiverRows, error: waiverError }] = await Promise.all([
        rosterQuery,
        waiverQuery,
    ])

    if (rosterError) throw rosterError
    if (waiverError) throw waiverError

    const ownedMap = new Map<string, OwnedEntry>()
    for (const row of (rosterRows ?? []) as OwnedPlayerRow[]) {
        ownedMap.set(row.player_id, {
            teamName: row.league_members?.team_name ?? 'Team',
            memberId: row.member_id,
        })
    }

    return {
        ownedMap,
        waiverIds: new Set(((waiverRows ?? []) as WaiverPlayerIdRow[]).map((row) => row.player_id)),
    }
}
