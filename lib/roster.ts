import { supabase } from '@/lib/supabase'
import { getActiveSeasonId } from '@/lib/shared/season'
import { isDTD, isIREligible, isTaxiEligible as isEligibleForTaxi } from '@pancake/core'
import { apiPost } from '@/lib/shared/api'
import { rpcError } from '@/lib/shared/errors'
import type { RosterSlotType } from '@/types/database'

export { isIREligible, isDTD }

export function isTaxiEligible(player: RosterPlayer['players']): boolean {
    return isEligibleForTaxi(player.nba_draft_number, player.years_exp)
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
        years_exp: number | null
    }
}

export type PlayerRosterStatus =
    | { status: 'mine'; rosterPlayerId: string }
    | { status: 'taken'; ownerTeamName: string }
    | { status: 'on_waivers'; logId: string; clearsAt: string }
    | { status: 'free_agent' }

export async function getRoster(memberId: string, leagueId: string): Promise<RosterPlayer[]> {
    const rosters = await getRostersForMembers([memberId], leagueId)
    return rosters[memberId] ?? []
}

export async function getRostersForMembers(
    memberIds: string[],
    leagueId: string,
): Promise<Record<string, RosterPlayer[]>> {
    const uniqueMemberIds = [...new Set(memberIds)]
    const rosters = Object.fromEntries(uniqueMemberIds.map((memberId) => [memberId, [] as RosterPlayer[]]))
    if (uniqueMemberIds.length === 0) return rosters
    const seasonId = await getActiveSeasonId(leagueId)
    if (!seasonId) return rosters

    const { data, error } = await supabase
        .from('roster_players')
        .select(
            `
      id, member_id, is_on_ir, is_on_taxi, acquired_via,
      players ( id, display_name, nba_team, position, eligible_positions, injury_status, nba_id, nba_draft_number, years_exp )
    `,
        )
        .in('member_id', uniqueMemberIds)
        .eq('league_season_id', seasonId)
        .order('is_on_taxi')
        .order('is_on_ir')

    if (error) throw error
    for (const row of data ?? []) {
        if (!row.players) continue
        const { member_id: memberId, ...rosterPlayer } = row
        rosters[memberId]?.push(rosterPlayer as RosterPlayer)
    }
    return rosters
}

export async function toggleIR(rosterPlayerId: string, isOnIR: boolean): Promise<void> {
    await apiPost('/league/roster/ir', { rosterPlayerId, isOnIR })
}

export async function toggleTaxi(rosterPlayerId: string, isOnTaxi: boolean): Promise<void> {
    await apiPost('/league/roster/taxi', { rosterPlayerId, isOnTaxi })
}

export type OwnedEntry = { teamName: string; memberId: string }
type OwnedPlayerRow = {
    player_id: string
    member_id: string
    league_members: { team_name: string | null } | null
}

export async function getOwnedPlayerMapForSeason(leagueId: string, seasonId: string): Promise<Map<string, OwnedEntry>> {
    const { data, error } = await supabase
        .from('roster_players')
        .select('player_id, member_id, league_members(team_name)')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)

    if (error) throw error
    const map = new Map<string, OwnedEntry>()
    for (const r of (data ?? []) as OwnedPlayerRow[]) {
        map.set(r.player_id, {
            teamName: r.league_members?.team_name ?? 'Team',
            memberId: r.member_id,
        })
    }
    return map
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

    const now = new Date().toISOString()
    const { data: waiverLog, error: waiverLogError } = await supabase
        .from('waiver_wire_log')
        .select('id, clears_at')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .eq('player_id', playerId)
        .is('cleared_at', null)
        .gt('clears_at', now)
        .order('clears_at', { ascending: true })
        .limit(1)
        .maybeSingle()
    if (waiverLogError) throw waiverLogError

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
        if (error.code === '23505') throw rpcError(error, 'This player is already on a roster.')
        throw rpcError(error)
    }
}

export async function dropAndAddFreeAgent(
    rosterPlayerId: string,
    memberId: string,
    leagueId: string,
    playerId: string,
): Promise<void> {
    const { error } = await supabase.rpc('drop_and_add_free_agent_atomic', {
        p_roster_player_id: rosterPlayerId,
        p_member_id: memberId,
        p_league_id: leagueId,
        p_player_id: playerId,
    })

    if (error) {
        if (error.code === '23505') throw rpcError(error, 'This player is already on a roster.')
        throw rpcError(error)
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
            throw rpcError(error, 'Could not drop player — you may not have permission or they are no longer on your roster.')
        }
        throw error
    }
}

export type RosterOverflowFreeAction = 'drop' | 'ir' | 'taxi'
export type RosterActivationSource = 'ir' | 'taxi'
export type RosterActivationWithLineup = {
    activateRosterPlayerId: string
    activateSource: RosterActivationSource
    freeRosterPlayerId?: string | null
    freeAction?: RosterOverflowFreeAction | null
    memberId: string
    leagueId: string
    seasonId: string
    gameDate: string
    weekNumber: number
    slotType?: string | null
}

export async function activateRosterPlayerWithOverflow(
    activateRosterPlayerId: string,
    activateSource: RosterActivationSource,
    freeRosterPlayerId: string,
    freeAction: RosterOverflowFreeAction,
): Promise<void> {
    const { error } = await supabase.rpc('activate_roster_player_with_overflow_atomic', {
        p_activate_roster_player_id: activateRosterPlayerId,
        p_activate_source: activateSource,
        p_free_roster_player_id: freeRosterPlayerId,
        p_free_action: freeAction,
    })

    if (error) throw rpcError(error)
}

export async function activateRosterPlayerWithLineup({
    activateRosterPlayerId,
    activateSource,
    freeRosterPlayerId = null,
    freeAction = null,
    memberId,
    leagueId,
    seasonId,
    gameDate,
    weekNumber,
    slotType = null,
}: RosterActivationWithLineup): Promise<void> {
    const { error } = await supabase.rpc('activate_roster_player_with_lineup_atomic', {
        p_activate_roster_player_id: activateRosterPlayerId,
        p_activate_source: activateSource,
        p_free_roster_player_id: freeRosterPlayerId,
        p_free_action: freeAction,
        p_member_id: memberId,
        p_league_id: leagueId,
        p_league_season_id: seasonId,
        p_game_date: gameDate,
        p_week_number: weekNumber,
        p_slot_type: slotType as RosterSlotType | null,
    })

    if (error) throw rpcError(error)
}
