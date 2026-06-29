import { todayET } from '../_shared/date.ts'
import { isRegularSeasonGameId } from '../_shared/nba.ts'
import { json, throwDb } from '../_shared/apiRuntime.ts'
import { supabase } from '../_shared/supabase.ts'

export async function handleGamesRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'GET' || path !== '/games/today') return null

  const { data, error } = await supabase
    .from('nba_games')
    .select('id, nba_game_id, home_team, away_team, home_score, away_score, status, game_status_text, game_date')
    .eq('game_date', todayET())
    .order('game_time', { ascending: true, nullsFirst: false })
    .order('status', { ascending: true })
    .order('id', { ascending: true })

  if (error) throwDb(error)
  return json({ games: (data ?? []).filter((game) => isRegularSeasonGameId(game.nba_game_id)) })
}
