import { gameElapsedSeconds } from '../_shared/gameProgress.ts'
import { supabase } from '../_shared/supabase.ts'
import { mapGameStatus } from '../_shared/nba.ts'
import type { NBAGame } from '../_shared/nba.ts'
import type { Database } from '../_shared/database.ts'

type StoredScoreboardGame = Pick<Database['public']['Tables']['nba_games']['Row'], 'id' | 'nba_game_id' | 'status' | 'home_score' | 'away_score' | 'game_status_text'>

export async function saveScoreboardGames(games: NBAGame[], work: StoredScoreboardGame[]): Promise<void> {
  const storedGames = new Map(work.map(game => [game.nba_game_id, game]))
  const missing = games.filter(game => game.gameStatus > 1 && !storedGames.has(game.gameId)).map(game => game.gameId)
  if (missing.length) {
    const { data, error } = await supabase.from('nba_games')
      .select('id,nba_game_id,status,home_score,away_score,game_status_text')
      .in('nba_game_id', missing)
    if (error) throw error
    for (const game of data ?? []) storedGames.set(game.nba_game_id, game)
  }
  for (const game of games) {
    const stored = storedGames.get(game.gameId)
    if (!stored || stored.status === 'Final') continue
    const status = mapGameStatus(game.gameStatus)
    const home = game.homeTeam.score ?? 0
    const away = game.awayTeam.score ?? 0
    const text = game.gameStatusText ?? ''
    if (stored.status === status && stored.home_score === home && stored.away_score === away && stored.game_status_text === text) continue
    const { error } = await supabase.rpc('save_live_scoreboard_atomic', {
      p_game_id: stored.id, p_provider_game_id: game.gameId, p_status: status,
      p_home_score: home, p_away_score: away, p_status_text: text,
      p_elapsed_seconds: game.gameStatus === 3 ? 0 : gameElapsedSeconds(game),
    })
    if (error) throw error
  }
}
