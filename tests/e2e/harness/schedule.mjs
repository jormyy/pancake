import { withSupabaseRetry } from '../soak-network.mjs'

export async function readSchedule(supabase, leagueId, seasonId) {
  const { data, error } = await withSupabaseRetry('matchup schedule', () => supabase.from('matchups').select('*')
    .eq('league_id', leagueId).eq('league_season_id', seasonId).order('id'))
  if (error || !data) throw new Error(`Matchup schedule read failed: ${error?.message ?? 'missing rows'}`)
  return data
}
