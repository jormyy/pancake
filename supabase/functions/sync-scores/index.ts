import { supabase } from '../_shared/supabase.ts'
import { syncScores } from '../_shared/syncScores.ts'
import { syncStatsByDate } from '../_shared/syncStats.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'
import {
  LIVE_POLL_LEASE_TTL_SECONDS,
  LIVE_POLL_LOCK_KEY,
  dateFromETDate,
  livePollCandidateDates,
} from '../_shared/livePoll.ts'

async function syncStatsForScoreCandidateDates(): Promise<void> {
  for (const date of livePollCandidateDates()) {
    await syncStatsByDate(dateFromETDate(date))
  }
}

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

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
      await syncStatsForScoreCandidateDates()
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
