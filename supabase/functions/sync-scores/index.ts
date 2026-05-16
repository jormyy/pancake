import { supabase } from '../_shared/supabase.ts'
import { syncScores } from '../_shared/syncScores.ts'
import { internalServerError } from '../_shared/responses.ts'

// Must match supabase/functions/live-poll/index.ts and
// backend/src/sync/livePoller.ts — manual sync-scores invocations need to
// share the same lease so they don't race the cron poller and crash on the
// (league_id, league_season_id, member_id, week_number) UNIQUE in
// standings_snapshots.
const LIVE_POLL_LOCK_KEY = 779001
const LIVE_POLL_LEASE_TTL_SECONDS = 90

Deno.serve(async () => {
  try {
    const { data: holderId, error: lockErr } = await supabase.rpc('try_live_poll_lease', {
      p_lock_key: LIVE_POLL_LOCK_KEY,
      p_ttl_seconds: LIVE_POLL_LEASE_TTL_SECONDS,
    })
    if (lockErr) throw lockErr
    if (!holderId) {
      return Response.json(
        { ok: false, error: 'Sync already in progress', action: 'lease-skip' },
        { status: 409 },
      )
    }

    try {
      await syncScores()
      return Response.json({ ok: true })
    } finally {
      const { error: releaseErr } = await supabase.rpc('release_live_poll_lease', {
        p_lock_key: LIVE_POLL_LOCK_KEY,
        p_holder_id: holderId,
      })
      if (releaseErr) console.error('[sync-scores] release lease failed:', releaseErr)
    }
  } catch (e: unknown) {
    return internalServerError('sync-scores', e)
  }
})
