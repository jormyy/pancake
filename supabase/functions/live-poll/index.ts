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
import { errorMessage, internalServerError } from '../_shared/responses.ts'

const LIVE_POLL_LOCK_KEY = 779001
// TTL must comfortably cover the longest in-loop sync. 90s leaves headroom
// over the 1-minute cron cadence; if the worker crashes the lease auto-clears.
const LIVE_POLL_LEASE_TTL_SECONDS = 90

Deno.serve(async () => {
  try {
    const { data: holderId, error: lockErr } = await supabase.rpc('try_live_poll_lease', {
      p_lock_key: LIVE_POLL_LOCK_KEY,
      p_ttl_seconds: LIVE_POLL_LEASE_TTL_SECONDS,
    })
    if (lockErr) throw lockErr
    if (!holderId) return Response.json({ ok: true, action: 'lease-skip' })

    try {
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

      // 1. Active games already in DB?
      const { data: activeGames } = await supabase
        .from('nba_games')
        .select('id')
        .eq('game_date', todayStr)
        .eq('status', 'InProgress')

      if (activeGames && activeGames.length > 0) {
        console.log(`[live-poll] ${activeGames.length} active games — syncing stats + scores`)
        await syncStatsByDate(new Date())
        await syncScores()
        return Response.json({ ok: true, action: 'synced', activeGames: activeGames.length })
      }

      // 2. No active games — check CDN scoreboard for status updates
      const cdnGames = await fetchTodaysGames().catch((e) => {
        console.warn('[live-poll] CDN scoreboard unavailable:', errorMessage(e))
        return []
      })

      if (!cdnGames.length) {
        return Response.json({ ok: true, action: 'idle' })
      }

      let statusUpdates = 0
      let nowActive = 0

      for (const g of cdnGames) {
        const newStatus = mapGameStatus(g.gameStatus)
        if (g.gameStatus === 2) nowActive++

        const { data: existing } = await supabase
          .from('nba_games')
          .select('id, status')
          .eq('nba_game_id', g.gameId)
          .maybeSingle()

        if (existing && existing.status !== newStatus) {
          await supabase
            .from('nba_games')
            .update({ status: newStatus, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
          statusUpdates++
        }
      }

      // If CDN shows games are now active, sync immediately
      if (nowActive > 0) {
        console.log(`[live-poll] ${nowActive} games just went live — syncing`)
        await syncStatsByDate(new Date())
        await syncScores()
        return Response.json({ ok: true, action: 'synced', statusUpdates, activeGames: nowActive })
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
  } catch (e: unknown) {
    return internalServerError('live-poll', e)
  }
})
