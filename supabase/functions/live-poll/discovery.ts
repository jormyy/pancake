import { supabase } from '../_shared/supabase.ts'
import { saveLiveFeedSnapshot } from '../_shared/liveFeed.ts'
import { gameElapsedSeconds } from '../_shared/gameProgress.ts'
import type { LiveSnapshot } from '../_shared/liveSnapshot.ts'

export async function discoverPublicGames(snapshot: LiveSnapshot): Promise<void> {
  const { data, error } = await supabase.from('nba_games')
    .select('id,nba_game_id,home_team,away_team,status')
    .eq('game_date',snapshot.date).eq('status','Scheduled').like('nba_game_id','002%')
    .abortSignal(AbortSignal.timeout(5000))
  if (error) throw error
  for (const game of snapshot.games) {
    const matches = (data ?? []).filter(row => game.nbaId ? row.nba_game_id === game.nbaId
      : row.home_team === game.home.team && row.away_team === game.away.team)
    if (matches.length > 1) throw new Error('Public game discovery is ambiguous')
    const stored = matches[0]
    if (!stored?.nba_game_id || game.status === 'Scheduled') continue
    await saveLiveFeedSnapshot(stored.id,stored.nba_game_id,{
      source:game.source ?? 'nba',source_updated_at:new Date(game.updatedAt).toISOString(),
      elapsed_seconds:gameElapsedSeconds({gameStatus:2,period:game.period,gameClock:game.clock}),
      status:'InProgress',home_score:game.home.score,away_score:game.away.score,status_text:'Live game discovered',
    })
  }
}
