import { supabase } from './supabase.ts'

export async function generateMatchups(
  leagueId: string,
  leagueSeasonId: string,
  force = false,
): Promise<void> {
  const { error } = await supabase.rpc('replace_regular_season_matchups_atomic', {
    p_league_id: leagueId,
    p_league_season_id: leagueSeasonId,
    p_force: force,
    p_matchups: [],
  })
  if (error) throw error
}

export async function generateAllMatchups(force = false, leagueId?: string): Promise<void> {
  let query = supabase
    .from('league_seasons')
    .select('id, league_id')
    .eq('is_current', true)
  if (leagueId) query = query.eq('league_id', leagueId)

  const { data: seasons, error } = await query
  if (error) throw error

  await Promise.all((seasons ?? []).map((season) =>
    generateMatchups(season.league_id, season.id, force)))
}
