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
