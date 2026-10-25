export type MatchupGenerationResult = { inserted: number; skipped: boolean }

import { supabase } from './supabase.ts'

export async function generateMatchups(
  leagueId: string,
  leagueSeasonId: string,
  force = false,
): Promise<MatchupGenerationResult> {
  const { data, error } = await supabase.rpc('replace_regular_season_matchups_atomic', {
    p_league_id: leagueId,
    p_league_season_id: leagueSeasonId,
    p_force: force,
    p_matchups: [],
  })
  if (error) throw error
  return data as MatchupGenerationResult
}

export async function generateAllMatchups(force = false, leagueId?: string): Promise<MatchupGenerationResult[]> {
  let query = supabase
    .from('league_seasons')
    .select('id, league_id')
    .eq('is_current', true)
  if (leagueId) query = query.eq('league_id', leagueId)

  const { data: seasons, error } = await query
  if (error) throw error

  return await Promise.all((seasons ?? []).map((season) =>
    generateMatchups(season.league_id, season.id, force)))
}
