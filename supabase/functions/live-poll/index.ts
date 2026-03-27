/**
 * live-poll — runs every 1 minute via pg_cron during game hours (11 AM - 1 AM ET).
 *
 * 1. Check nba_games for InProgress games today → sync stats + scores immediately.
 * 2. If none active, hit CDN scoreboard to update statuses; if newly live, sync.
 * 3. Fast return when nothing to do.
 */
import { supabase } from '../_shared/supabase.ts'
import { fetchTodaysGames, mapGameStatus } from '../_shared/nba.ts'
import { syncStatsByDate } from '../_shared/syncStats.ts'
import { syncScores } from '../_shared/syncScores.ts'

Deno.serve(async () => {
  try {
    const todayStr = new Date().toISOString().split('T')[0]

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
      console.warn('[live-poll] CDN scoreboard unavailable:', e.message)
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
  } catch (e: any) {
    console.error('[live-poll]', e)
    return Response.json({ ok: false, error: e.message }, { status: 500 })
  }
})
