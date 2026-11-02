import { supabase } from '../_shared/supabase.ts'
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
    if (game.updatedAt > Date.now()+5000 || game.status !== 'Final' && Date.now()-game.updatedAt > 120000)
      throw new Error('Public game discovery is stale')
    const { error } = await supabase.rpc('save_live_scoreboard_atomic',{
      p_game_id:stored.id,p_provider_game_id:stored.nba_game_id,p_status:'InProgress',
      p_elapsed_seconds:game.status === 'Final' ? 2880+Math.max(0,(game.period ?? 4)-4)*300
        : gameElapsedSeconds({gameStatus:2,period:game.period,gameClock:game.clock}),
      p_home_score:game.home.score,p_away_score:game.away.score,p_status_text:'Live game discovered',
    }).abortSignal(AbortSignal.timeout(5000))
    if (error) throw error
  }
}
