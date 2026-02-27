import { supabase } from '@/lib/supabase'

export type RosterPlayer = {
  id: string
  is_on_ir: boolean
  acquired_via: string
  players: {
    id: string
    display_name: string
    nba_team: string | null
    position: string | null
    injury_status: string | null
  }
}

export type PlayerRosterStatus =
  | { status: 'mine'; rosterPlayerId: string }
  | { status: 'taken'; ownerTeamName: string }
  | { status: 'free_agent' }

async function getCurrentSeasonId(leagueId: string): Promise<string | null> {
  const { data } = await supabase
    .from('league_seasons')
    .select('id')
    .eq('league_id', leagueId)
    .eq('is_current', true)
    .single()
  return data?.id ?? null
}

export async function getRoster(memberId: string, leagueId: string): Promise<RosterPlayer[]> {
  const seasonId = await getCurrentSeasonId(leagueId)
  if (!seasonId) return []

  const { data, error } = await supabase
    .from('roster_players')
    .select(`
      id, is_on_ir, acquired_via,
      players ( id, display_name, nba_team, position, injury_status )
    `)
    .eq('member_id', memberId)
    .eq('league_season_id', seasonId)
    .order('is_on_ir')

  if (error) throw error
  return (data ?? []) as unknown as RosterPlayer[]
}

export async function toggleIR(rosterPlayerId: string, isOnIR: boolean): Promise<void> {
  const { error } = await supabase
    .from('roster_players')
    .update({ is_on_ir: isOnIR })
    .eq('id', rosterPlayerId)
  if (error) throw error
}

// Returns a set of player_id values currently owned in the league/season
export async function getOwnedPlayerIds(leagueId: string): Promise<Set<string>> {
  const seasonId = await getCurrentSeasonId(leagueId)
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
  const seasonId = await getCurrentSeasonId(leagueId)
  if (!seasonId) return { status: 'free_agent' }

  const { data, error } = await supabase
    .from('roster_players')
    .select('id, member_id, league_members ( team_name )')
    .eq('player_id', playerId)
    .eq('league_id', leagueId)
    .eq('league_season_id', seasonId)
    .maybeSingle()

  if (error) throw error
  if (!data) return { status: 'free_agent' }
  if (data.member_id === memberId) return { status: 'mine', rosterPlayerId: data.id }
  const owner = data.league_members as any
  return { status: 'taken', ownerTeamName: owner?.team_name ?? 'Another team' }
}

export async function addFreeAgent(
  memberId: string,
  leagueId: string,
  playerId: string,
): Promise<void> {
  const seasonId = await getCurrentSeasonId(leagueId)
  if (!seasonId) throw new Error('No active season found.')

  // Fetch the league's roster size cap
  const { data: league, error: leagueErr } = await supabase
    .from('leagues')
    .select('roster_size')
    .eq('id', leagueId)
    .single()
  if (leagueErr) throw leagueErr

  // Count member's current active (non-IR) roster slots
  const { count, error: countErr } = await supabase
    .from('roster_players')
    .select('id', { count: 'exact', head: true })
    .eq('member_id', memberId)
    .eq('league_season_id', seasonId)
    .eq('is_on_ir', false)
  if (countErr) throw countErr

  const rosterSize = league.roster_size ?? 20
  if ((count ?? 0) >= rosterSize) {
    throw new Error(`Your active roster is full (${rosterSize} players).`)
  }

  const { error } = await supabase
    .from('roster_players')
    .insert({
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
}

export async function dropPlayer(rosterPlayerId: string): Promise<void> {
  const { error } = await supabase
    .from('roster_players')
    .delete()
    .eq('id', rosterPlayerId)
  if (error) throw error
}
