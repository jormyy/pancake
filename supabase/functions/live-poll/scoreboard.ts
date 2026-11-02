import { runBounded } from '../_shared/runBounded.ts'
import { withWorkContext, withPublicCheckpoint } from '../_shared/workContext.ts'
import { saveLiveFeedSnapshot } from '../_shared/liveFeed.ts'
import { gameElapsedSeconds } from '../_shared/gameProgress.ts'
import { supabase } from '../_shared/supabase.ts'
import { mapGameStatus } from '../_shared/nba.ts'
import type { NBAGame } from '../_shared/nba.ts'
import type { Database } from '../_shared/database.ts'

type StoredScoreboardGame = Pick<Database['public']['Tables']['nba_games']['Row'], 'id' | 'nba_game_id' | 'status' | 'home_score' | 'away_score' | 'game_status_text'>

let startOffset = 0

export async function saveScoreboardGames(games: NBAGame[], work: StoredScoreboardGame[], selected?: ReadonlySet<string>, startSignal?: AbortSignal): Promise<{gameId:string;error:unknown}[]> {
  const startsOnly = selected?.size === 0
  const signal = startsOnly ? startSignal ?? AbortSignal.timeout(5000) : undefined
  const storedGames = new Map(work.map(game => [game.nba_game_id, game]))
  const missing = games.filter(game => game.gameStatus === 2 && !storedGames.has(game.gameId)).map(game => game.gameId)
  if (missing.length) {
    const request = supabase.from('nba_games')
      .select('id,nba_game_id,status,home_score,away_score,game_status_text')
      .in('nba_game_id', missing)
    const { data, error } = await (signal ? request.abortSignal(signal) : request)
    if (error) throw error
    for (const game of data ?? []) storedGames.set(game.nba_game_id, game)
  }
  const failures:{gameId:string;error:unknown}[]=[]
  const offset = startsOnly && games.length ? startOffset % games.length : 0
  let nextOffset = offset
  const ordered = [...games.slice(offset), ...games.slice(0, offset)]
  await runBounded(ordered.map((game,index) => async () => {
    if (signal?.aborted) return
    const stored = storedGames.get(game.gameId)
    if (!stored || stored.status === 'Final' || game.gameStatus === 3) return
    if (selected && !selected.has(stored.id) && stored.status !== 'Scheduled') return
    nextOffset = (offset+index+1) % games.length
    const save = async () => {
      const status = mapGameStatus(game.gameStatus)
      const home = game.homeTeam.score ?? 0
      const away = game.awayTeam.score ?? 0
      const text = game.gameStatusText ?? ''
      if (stored.status === status && stored.home_score === home && stored.away_score === away && stored.game_status_text === text) return
      if (game.sourceUpdatedAt && game.gameStatus !== 3) {
        await saveLiveFeedSnapshot(stored.id, game.gameId, { source: 'nba', source_updated_at: game.sourceUpdatedAt,
          elapsed_seconds: gameElapsedSeconds(game), status, home_score: home, away_score: away, status_text: text })
        return
      }
      const { error } = await supabase.rpc('save_live_scoreboard_atomic', {
        p_game_id: stored.id, p_provider_game_id: game.gameId, p_status: status,
        p_home_score: home, p_away_score: away, p_status_text: text,
        p_elapsed_seconds: game.gameStatus === 3 ? 0 : gameElapsedSeconds(game),
      })
      if (error) throw error
    }
    try {
      if (startsOnly) await withWorkContext({signal:AbortSignal.any([signal!,AbortSignal.timeout(3000)])}, () => withPublicCheckpoint(false,save))
      else if (stored.status === 'Scheduled' && game.gameStatus === 2) await withPublicCheckpoint(false,save)
      else await save()
    } catch(error) { failures.push({gameId:stored.id,error}) }
  }), startsOnly ? 2 : 1)
  if (startsOnly && games.length) startOffset = signal?.aborted ? nextOffset : offset+1
  return failures
}
