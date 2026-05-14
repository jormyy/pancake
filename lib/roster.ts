import { supabase } from '@/lib/supabase'
import { logTransaction } from '@/lib/transactions'
import { getCurrentSeasonId, getActiveSeasonId } from '@/lib/shared/season'
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
    const seasonId = await getCurrentSeasonId(leagueId)
    if (!seasonId) throw new Error('No active season found.')

    // Check for ineligible IR players before allowing add
    const { data: rosterPlayers, error: rosterErr } = await supabase
        .from('roster_players')
        .select('is_on_ir, is_on_taxi, players ( display_name, injury_status )')
        .eq('member_id', memberId)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .eq('is_on_ir', true)
    if (rosterErr) throw rosterErr

    if (rosterPlayers && rosterPlayers.length > 0) {
        const ineligible = rosterPlayers.filter(
            (rp) => !isIREligible(rp.players?.injury_status)
        )
        if (ineligible.length > 0) {
            const names = ineligible.map((rp) => rp.players?.display_name ?? 'Unknown').join(', ')
            throw new Error(
                `You have ineligible players on IR (${names}). Activate or drop them before adding players.`
            )
        }
    }

    // Fetch the league's roster size cap
    const { data: league, error: leagueErr } = await supabase
        .from('leagues')
        .select('roster_size')
        .eq('id', leagueId)
        .single()
    if (leagueErr) throw leagueErr

    // Count member's current active (non-IR, non-taxi) roster slots
    const { count, error: countErr } = await supabase
        .from('roster_players')
        .select('id', { count: 'exact', head: true })
        .eq('member_id', memberId)
        .eq('league_season_id', seasonId)
        .eq('is_on_ir', false)
        .eq('is_on_taxi', false)
    if (countErr) throw countErr

    const rosterSize = league.roster_size ?? 20
    if ((count ?? 0) >= rosterSize) {
        throw new Error(`Your active roster is full (${rosterSize} players).`)
    }

    const { error } = await supabase.from('roster_players').insert({
        member_id: memberId,
        league_id: leagueId,
        league_season_id: seasonId,
        player_id: playerId,
        acquired_via: 'free_agent',
    })

    if (error) {
        if (error.code === '23505') throw new Error('This player is already on a roster.')
        throw error
    }

    await logTransaction({ leagueId, leagueSeasonId: seasonId, memberId, playerId, transactionType: 'fa_add' })
}

export async function dropPlayer(rosterPlayerId: string): Promise<void> {
    // Fetch roster row so we can create the waiver entry
    const { data: rp, error: fetchErr } = await supabase
        .from('roster_players')
        .select('id, member_id, league_id, league_season_id, player_id')
        .eq('id', rosterPlayerId)
        .single()
    if (fetchErr) throw fetchErr
    if (!rp) throw new Error('Roster player not found.')

    const { error: deleteErr, count: deleteCount } = await supabase
        .from('roster_players')
        .delete({ count: 'exact' })
        .eq('id', rosterPlayerId)
    if (deleteErr) throw deleteErr
    if (deleteCount === 0) throw new Error('Could not drop player — you may not have permission or they are no longer on your roster.')

    // Place on waivers for 48 hours
    const clearsAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const { error: waiverErr } = await supabase.from('waiver_wire_log').insert({
        league_id: rp.league_id,
        league_season_id: rp.league_season_id,
        player_id: rp.player_id,
        dropped_by_member_id: rp.member_id,
        clears_at: clearsAt,
    })
    if (waiverErr) throw waiverErr

    await logTransaction({
        leagueId: rp.league_id,
        leagueSeasonId: rp.league_season_id,
        memberId: rp.member_id,
        playerId: rp.player_id,
        transactionType: 'fa_drop',
    })
}
