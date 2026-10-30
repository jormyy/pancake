import type { AssetLock } from '@/lib/locked-assets'
import { assertReadActive } from '@/lib/shared/read-admission'
import { assertMutationOnline, withPwaMutation } from '@/lib/shared/pwa-mutation'
import { supabase } from '@/lib/supabase'
import { getActiveSeasonId } from '@/lib/shared/season'
import { isDTD, isIREligible } from '@pancake/core'
import { apiPost } from '@/lib/shared/api'
import { rpcError } from '@/lib/shared/errors'
import type { RosterSlotType } from '@/types/database'

export { isIREligible, isDTD }

export type RosterPlayer = {
    assetLocks?: AssetLock[]
    id: string
    is_on_ir: boolean
    is_on_taxi: boolean
    taxi_start_season_year?: number | null
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
        career_regular_season_games?: number | null
        birthdate?: string | null
        years_exp: number | null
    }
}

export type PlayerRosterStatus =
    | { status: 'mine'; rosterPlayerId: string; isOnTaxi?: boolean }
    | { status: 'taken'; ownerTeamName: string; isOnTaxi?: boolean }
    | { status: 'on_waivers'; logId: string; clearsAt: string }
    | { status: 'free_agent' }

export async function getRoster(memberId: string, leagueId: string, leagueSeasonId?: string): Promise<RosterPlayer[]> {
    const rosters = await getRostersForMembers([memberId], leagueId, leagueSeasonId)
    return rosters[memberId] ?? []
}

export async function getRostersForMembers(
    memberIds: string[],
    leagueId: string,
    leagueSeasonId?: string,
): Promise<Record<string, RosterPlayer[]>> {
    const uniqueMemberIds = [...new Set(memberIds)]
    const rosters = Object.fromEntries(uniqueMemberIds.map((memberId) => [memberId, [] as RosterPlayer[]]))
    if (uniqueMemberIds.length === 0) return rosters
    const seasonId = leagueSeasonId ?? await getActiveSeasonId(leagueId)
    if (!seasonId) return rosters

    const { data, error } = await supabase
        .from('roster_players')
        .select(
            `
      id, member_id, is_on_ir, is_on_taxi, acquired_via, taxi_start_season_year,
      players ( id, display_name, nba_team, position, eligible_positions, injury_status, nba_id, nba_draft_number, birthdate, years_exp, career_regular_season_games )
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

export type RosterOccupancy = Pick<RosterPlayer, 'is_on_ir'>
export type OwnedEntry = { teamName: string; memberId: string; isOnIR?: boolean; isOnTaxi?: boolean }
type OwnedPlayerRow = {
    player_id: string
    member_id: string
    is_on_ir: boolean
    is_on_taxi: boolean
    league_members: { team_name: string | null } | null
}

export async function getOwnedPlayerMapForSeason(leagueId: string, seasonId: string): Promise<Map<string, OwnedEntry>> {
    const { data, error } = await supabase
        .from('roster_players')
        .select('player_id, member_id, is_on_ir, is_on_taxi, league_members(team_name)')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)

    if (error) throw error
    const map = new Map<string, OwnedEntry>()
    for (const r of (data ?? []) as OwnedPlayerRow[]) {
        map.set(r.player_id, {
            teamName: r.league_members?.team_name ?? 'Team',
            memberId: r.member_id,
            isOnIR: r.is_on_ir,
            isOnTaxi: r.is_on_taxi,
        })
    }
    return map
}

export async function getPlayerRosterContext(
    playerId: string,
    memberId: string,
    leagueId: string,
    canRead?: () => boolean,
): Promise<{ status: PlayerRosterStatus; roster: RosterOccupancy[] }> {
    assertReadActive(canRead)
    const seasonId = await getActiveSeasonId(leagueId)
    assertReadActive(canRead)
    if (!seasonId) return { status: { status: 'free_agent' }, roster: [] }

    const { data, error } = await supabase
        .from('roster_players')
        .select('id, player_id, member_id, is_on_ir, is_on_taxi, league_members ( team_name )')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .or(`player_id.eq.${playerId},member_id.eq.${memberId}`)
    if (error) throw error
    const roster = (data ?? []).filter(row => row.member_id === memberId).map(row => ({ is_on_ir: row.is_on_ir }))
    const owned = data?.find(row => row.player_id === playerId)
    if (owned) {
        const status: PlayerRosterStatus = owned.member_id === memberId
            ? { status: 'mine', rosterPlayerId: owned.id, isOnTaxi: owned.is_on_taxi }
            : { status: 'taken', ownerTeamName: owned.league_members?.team_name ?? 'Another team', isOnTaxi: owned.is_on_taxi }
        return { status, roster }
    }

    assertReadActive(canRead)
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
        return { status: { status: 'on_waivers', logId: waiverLog.id, clearsAt: waiverLog.clears_at }, roster }
    }

    return { status: { status: 'free_agent' }, roster }
}

export async function addFreeAgent(
    memberId: string,
    leagueId: string,
    playerId: string,
    toIr = false,
    toTaxi = false,
): Promise<void> {
    return withPwaMutation('addFreeAgent', async () => {
        // Atomic: validate caller ownership, waiver hold, roster-cap, and insert
        // both the roster_players row and the roster_transactions audit row in a
        // single SECURITY DEFINER RPC. The prior client-side INSERT had a race
        // window between drop_player_atomic's commit and another tab's
        // getPlayerRosterContext refresh, letting a second user scoop a player off
        // waivers and breaking queued waiver_claims.
        const args = {
            p_member_id: memberId,
            p_league_id: leagueId,
            p_player_id: playerId,
            p_to_ir: toIr,
            p_to_taxi: toTaxi,
        }
        const { error } = await supabase.rpc('add_free_agent_atomic', args)

        if (error) {
            if (error.code === '23505') throw rpcError(error, 'This player is already on a roster.')
            throw rpcError(error)
        }
    })
}

export async function dropAndAddFreeAgent(
    rosterPlayerId: string,
    memberId: string,
    leagueId: string,
    playerId: string,
): Promise<void> {
    return withPwaMutation('dropAndAddFreeAgent', async () => {
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
    })
}

export async function dropPlayer(rosterPlayerId: string, expectedLeagueSeasonId?: string, rookieDraftId?: string): Promise<void> {
    return withPwaMutation('dropPlayer', async () => {
        assertMutationOnline()
        // Atomic: delete roster row, insert 48h waiver_wire_log, insert
        // roster_transactions audit row — all in a single Postgres transaction.
        // Prior implementation issued 3 serial writes with no rollback, so a
        // failure between steps could remove the player from the roster without
        // ever placing them on waivers.
        const { error } = await supabase.rpc('drop_player_atomic', {
            p_roster_player_id: rosterPlayerId,
            ...(expectedLeagueSeasonId ? { p_expected_league_season_id: expectedLeagueSeasonId } : {}),
            ...(rookieDraftId ? { p_rookie_draft_id: rookieDraftId } : {}),
        })
        if (error) {
            if (error.code === 'P0002') {
                throw rpcError(error, 'Could not drop player — you may not have permission or they are no longer on your roster.')
            }
            throw error
        }
    })
}

type RosterOverflowFreeAction = 'drop' | 'ir'
type RosterActivationSource = 'ir' | 'taxi'
type RosterActivationWithLineup = {
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
    return withPwaMutation('activateRosterPlayerWithOverflow', async () => {
        const { error } = await supabase.rpc('activate_roster_player_with_overflow_atomic', {
            p_activate_roster_player_id: activateRosterPlayerId,
            p_activate_source: activateSource,
            p_free_roster_player_id: freeRosterPlayerId,
            p_free_action: freeAction,
        })

        if (error) throw rpcError(error)
    })
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
    return withPwaMutation('activateRosterPlayerWithLineup', async () => {
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
    })
}


export async function getTaxiExitPlayerIds(memberId: string, leagueId: string): Promise<Set<string>> {
    const { data, error } = await supabase.from('league_member_taxi_exits').select('player_id')
        .eq('member_id', memberId).eq('league_id', leagueId)
    if (error) throw error
    return new Set((data ?? []).map(row => row.player_id))
}
