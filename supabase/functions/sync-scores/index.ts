import { supabase } from '../_shared/supabase.ts'
import { syncScores } from '../_shared/syncScores.ts'
import { syncStatsForDates } from '../_shared/syncStats.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'
import {
  LIVE_POLL_LEASE_TTL_SECONDS,
  LIVE_POLL_LOCK_KEY,
  livePollCandidateDates,
} from '../_shared/livePoll.ts'

async function syncStatsForScoreCandidateDates(): Promise<number> {
  return await syncStatsForDates(livePollCandidateDates())
}

serveInternal('sync-scores', async (req) => {
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  const leagueId = typeof body.leagueId === 'string' ? body.leagueId : undefined
  const date = typeof body.date === 'string' ? new Date(body.date) : null
  if (date && !Number.isNaN(date.getTime())) {
    await recordSyncRun('sync-scores', async () => {
      await syncScores(leagueId, date)
      return { result: undefined, rowsAffected: null }
    })
    return Response.json({ ok: true, date: body.date, leagueId: leagueId ?? null })
  }

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
    await recordSyncRun('sync-scores', async () => {
      const statLines = await syncStatsForScoreCandidateDates()
      await syncScores()
      return { result: undefined, rowsAffected: statLines }
    })
    return Response.json({ ok: true })
  } finally {
    const { error: releaseErr } = await supabase.rpc('release_live_poll_lease', {
      p_lock_key: LIVE_POLL_LOCK_KEY,
      p_holder_id: holderId,
    })
    if (releaseErr) console.error('[sync-scores] release lease failed:', releaseErr)
  }
})
