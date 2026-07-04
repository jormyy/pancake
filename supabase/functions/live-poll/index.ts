/**
 * live-poll — runs every 1 minute via pg_cron during game hours (11 AM - 1 AM ET).
 *
 * 1. Check nba_games for InProgress games today → sync stats + scores immediately.
 * 2. If none active, hit CDN scoreboard to update statuses; if newly live, sync.
 * 3. Fast return when nothing to do.
 *
 * Dedup model — TTL lease (try_live_poll_lease / release_live_poll_lease):
 *   PostgREST routes each RPC over a pooled backend, so a session-scoped
 *   pg_try_advisory_lock can be acquired on one connection and released on
 *   another (release silently no-ops, lock leaks). We use a persisted lease
 *   row keyed by lock_key with an expires_at TTL. Acquire returns a holder
 *   uuid; release only succeeds for that holder. A crashed worker self-heals
 *   after the TTL elapses.
 */
import { supabase } from '../_shared/supabase.ts'
import { fetchTodaysGames, mapGameStatus } from '../_shared/nba.ts'
import { syncStatsByDate } from '../_shared/syncStats.ts'
import { syncScores } from '../_shared/syncScores.ts'
import { serveInternal } from '../_shared/serve.ts'
import { errorMessage } from '../_shared/responses.ts'
import {
  LIVE_POLL_LEASE_TTL_SECONDS,
  LIVE_POLL_LOCK_KEY,
  dateFromETDate,
  livePollCandidateDates,
} from '../_shared/livePoll.ts'

serveInternal('live-poll', async () => {
  const { data: holderId, error: lockErr } = await supabase.rpc('try_live_poll_lease', {
    p_lock_key: LIVE_POLL_LOCK_KEY,
    p_ttl_seconds: LIVE_POLL_LEASE_TTL_SECONDS,
  })
  if (lockErr) throw lockErr
  if (!holderId) return Response.json({ ok: true, action: 'lease-skip' })

  try {
    const candidateDates = livePollCandidateDates()

    const { data: activeGames, error: activeGamesError } = await supabase
      .from('nba_games')
      .select('id')
      .in('game_date', candidateDates)
      .eq('status', 'InProgress')
    if (activeGamesError) throw activeGamesError

    const cdnGames = await fetchTodaysGames().catch((e) => {
      console.warn('[live-poll] CDN scoreboard unavailable:', errorMessage(e))
      return []
    })

    if (!cdnGames.length) {
      if (activeGames && activeGames.length > 0) {
        console.log(`[live-poll] ${activeGames.length} DB-active games, CDN unavailable — syncing stats + scores`)
        await syncCandidateDates(candidateDates)
        await syncScores()
        return Response.json({ ok: true, action: 'synced-db-active', activeGames: activeGames.length })
      }
      return Response.json({ ok: true, action: 'idle' })
    }

    let nowActive = 0
    const allDone = cdnGames.length > 0 && cdnGames.every((game) => game.gameStatus === 3)

    const { data: existingGames, error: existingError } = await supabase
      .from('nba_games')
      .select('id, nba_game_id, status, home_score, away_score, game_status_text, game_date, home_team, away_team, season_year, week_number')
      .in('nba_game_id', cdnGames.map((g) => g.gameId))
    if (existingError) throw existingError

    const existingByGameId = new Map((existingGames ?? []).map((game) => [game.nba_game_id, game]))
    const updatedAt = new Date().toISOString()
    const gameUpdates = []
    for (const g of cdnGames) {
      const newStatus = mapGameStatus(g.gameStatus)
      if (g.gameStatus === 2) nowActive++

      const existing = existingByGameId.get(g.gameId)
      if (!existing) continue

      const homeScore = g.homeTeam.score ?? 0
      const awayScore = g.awayTeam.score ?? 0
      const gameStatusText = g.gameStatusText ?? ''
      if (
        existing.status !== newStatus ||
        existing.home_score !== homeScore ||
        existing.away_score !== awayScore ||
        existing.game_status_text !== gameStatusText
      ) {
        gameUpdates.push({
          id: existing.id,
          game_date: existing.game_date,
          home_team: existing.home_team,
          away_team: existing.away_team,
          season_year: existing.season_year,
          week_number: existing.week_number,
          status: newStatus,
          home_score: homeScore,
          away_score: awayScore,
          game_status_text: gameStatusText,
          updated_at: updatedAt,
        })
      }
    }

    if (gameUpdates.length > 0) {
      const { error: updateError } = await supabase
        .from('nba_games')
        .upsert(gameUpdates, { onConflict: 'id' })
      if (updateError) throw updateError
    }
    const statusUpdates = gameUpdates.length

    const shouldSync = nowActive > 0 || allDone || (activeGames?.length ?? 0) > 0
    if (shouldSync) {
      console.log(`[live-poll] syncing stats + scores; active=${nowActive}, allDone=${allDone}, priorDbActive=${activeGames?.length ?? 0}`)
      await syncCandidateDates(candidateDates)
      await syncScores()
      return Response.json({ ok: true, action: 'synced', statusUpdates, activeGames: nowActive, allDone })
    }

    console.log(`[live-poll] No active games. Updated ${statusUpdates} statuses.`)
    return Response.json({ ok: true, action: 'status-check', statusUpdates })
  } finally {
    const { error: releaseErr } = await supabase.rpc('release_live_poll_lease', {
      p_lock_key: LIVE_POLL_LOCK_KEY,
      p_holder_id: holderId,
    })
    if (releaseErr) console.error('[live-poll] release lease failed:', releaseErr)
  }
})

async function syncCandidateDates(candidateDates: string[]): Promise<void> {
  for (const date of candidateDates) {
    await syncStatsByDate(dateFromETDate(date))
  }
}
