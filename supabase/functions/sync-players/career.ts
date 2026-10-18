import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { runBounded } from '../_shared/runBounded.ts'
import { careerRegularSeasonGames } from '../_shared/careerGames.ts'
import { fetchAllPlayers } from './players.ts'

const ESPN_CAREER_BASE_URL = Deno.env.get('ESPN_CAREER_BASE_URL') ??
  'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba'

export async function syncCareerGames(): Promise<{ updated: number; failures: string[] }> {
  const players = await fetchAllPlayers<{ id: string; espn_id: string | null }>(supabase, 'id, espn_id')
  let updated = 0
  const failures: string[] = []
  await runBounded(players.filter((player) => player.espn_id).map((player) => async () => {
    let games: number | null = null
    try {
      const response = await fetchWithRetry(`${ESPN_CAREER_BASE_URL}/athletes/${player.espn_id}/stats?seasontype=2`)
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`ESPN career stats ${response.status}`)
      }
      games = careerRegularSeasonGames(await response.json())
    } catch (error) {
      failures.push(`${player.id}: ${String(error)}`)
    }
    const { error } = await supabase.from('players').update({
      career_regular_season_games: games,
      career_games_checked_at: new Date().toISOString(),
    }).eq('id', player.id).eq('espn_id', player.espn_id!)
    if (error) failures.push(`${player.id}: ${error.message}`)
    else updated++
  }), 6)
  return { updated, failures }
}
