import { supabase } from '@/lib/supabase'
import { getActiveSeasonId } from '@/lib/shared/season'
import { isDTD, isIREligible, isTaxiEligible as isEligibleForTaxi } from '@pancake/core'
import { apiPost } from '@/lib/shared/api'

export { isIREligible, isDTD }

export function isTaxiEligible(player: RosterPlayer['players']): boolean {
    return isEligibleForTaxi(player.nba_draft_number)
}

export type RosterPlayer = {
    id: string
    is_on_ir: boolean
    is_on_taxi: boolean
    acquired_via: string
    players: {
        id: string
        display_name: string
        nba_team: string | null
        position: string | null
        eligible_positions: string[]
        injury_status: string | null
        nba_id: string | null
        nba_draft_number: number | null
    }
}

export type PlayerRosterStatus =
    | { status: 'mine'; rosterPlayerId: string }
    | { status: 'taken'; ownerTeamName: string }
    | { status: 'on_waivers'; logId: string; clearsAt: string }
    | { status: 'free_agent' }

export async function getRoster(memberId: string, leagueId: string): Promise<RosterPlayer[]> {
    const seasonId = await getActiveSeasonId(leagueId)
    if (!seasonId) return []

    const { data, error } = await supabase
        .from('roster_players')
        .select(
            `
      id, is_on_ir, is_on_taxi, acquired_via,
      players ( id, display_name, nba_team, position, eligible_positions, injury_status, nba_id, nba_draft_number )
    `,
        )
        .eq('member_id', memberId)
        .eq('league_season_id', seasonId)
        .order('is_on_taxi')
        .order('is_on_ir')

    if (error) throw error
    return (data ?? []) as unknown as RosterPlayer[]
}

export async function toggleIR(rosterPlayerId: string, isOnIR: boolean): Promise<void> {
    await apiPost('/league/roster/ir', { rosterPlayerId, isOnIR })
}

export async function toggleTaxi(rosterPlayerId: string, isOnTaxi: boolean): Promise<void> {
    await apiPost('/league/roster/taxi', { rosterPlayerId, isOnTaxi })
}

export type OwnedEntry = { teamName: string; memberId: string }

// Returns a map of player_id → { teamName, memberId } for all owned players in the league
export async function getOwnedPlayerMap(leagueId: string): Promise<Map<string, OwnedEntry>> {
    const seasonId = await getActiveSeasonId(leagueId)
    if (!seasonId) return new Map()

    const { data, error } = await supabase
        .from('roster_players')
        .select('player_id, member_id, league_members(team_name)')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)

    if (error) throw error
    const map = new Map<string, OwnedEntry>()
    for (const r of data ?? []) {
        map.set(r.player_id, {
            teamName: r.league_members?.team_name ?? 'Team',
            memberId: r.member_id,
        })
    }
    return map
}

// Returns a set of player_id values currently owned in the league/season
export async function getOwnedPlayerIds(leagueId: string): Promise<Set<string>> {
    const seasonId = await getActiveSeasonId(leagueId)
    if (!seasonId) return new Set()

    const { data, error } = await supabase
        .from('roster_players')
        .select('player_id')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)

    if (error) throw error
    return new Set((data ?? []).map((r) => r.player_id))
}

export async function getPlayerRosterStatus(
    playerId: string,
    memberId: string,
    leagueId: string,
): Promise<PlayerRosterStatus> {
    const seasonId = await getActiveSeasonId(leagueId)
    if (!seasonId) return { status: 'free_agent' }

    const { data, error } = await supabase
        .from('roster_players')
        .select('id, member_id, league_members ( team_name )')
        .eq('player_id', playerId)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .maybeSingle()

    if (error) throw error
    if (data) {
        if (data.member_id === memberId) return { status: 'mine', rosterPlayerId: data.id }
        return { status: 'taken', ownerTeamName: data.league_members?.team_name ?? 'Another team' }
    }

    // Check if on waivers
    const now = new Date().toISOString()
    const { data: waiverLog } = await supabase
        .from('waiver_wire_log')
        .select('id, clears_at')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .eq('player_id', playerId)
        .is('cleared_at', null)
        .gt('clears_at', now)
        .maybeSingle()

    if (waiverLog) {
        return { status: 'on_waivers', logId: waiverLog.id, clearsAt: waiverLog.clears_at }
    }

    return { status: 'free_agent' }
}

export async function addFreeAgent(
    memberId: string,
    leagueId: string,
    playerId: string,
): Promise<void> {
    // Atomic: validate caller ownership, waiver hold, roster-cap, and insert
    // both the roster_players row and the roster_transactions audit row in a
    // single SECURITY DEFINER RPC. The prior client-side INSERT had a race
    // window between drop_player_atomic's commit and another tab's
    // getPlayerRosterStatus refresh, letting a second user scoop a player off
    // waivers and breaking queued waiver_claims.
    const { error } = await supabase.rpc('add_free_agent_atomic', {
        p_member_id: memberId,
        p_league_id: leagueId,
        p_player_id: playerId,
    })

    if (error) {
        if (error.code === '23505') throw new Error('This player is already on a roster.')
        throw new Error(error.message)
    }
}

export async function dropPlayer(rosterPlayerId: string): Promise<void> {
    // Atomic: delete roster row, insert 48h waiver_wire_log, insert
    // roster_transactions audit row — all in a single Postgres transaction.
    // Prior implementation issued 3 serial writes with no rollback, so a
    // failure between steps could remove the player from the roster without
    // ever placing them on waivers.
    const { error } = await supabase.rpc('drop_player_atomic', {
        p_roster_player_id: rosterPlayerId,
    })
    if (error) {
        if (error.code === 'P0002') {
            throw new Error('Could not drop player — you may not have permission or they are no longer on your roster.')
        }
        throw error
    }
}
