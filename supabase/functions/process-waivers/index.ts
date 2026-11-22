import { retryDatabaseContention } from '../_shared/databaseRetry.ts'
import { supabase } from '../_shared/supabase.ts'
import type { Database, Json } from '../_shared/database.ts'
import { serveInternal } from '../_shared/serve.ts'
import { drainDueClaims, PROCESS_BATCH_LIMIT } from './drain.ts'

type WaiverProcessRow = Pick<Database['public']['Functions']['process_due_waiver_claims_atomic']['Returns'][number], 'processed'>
type RosterFloorLeague = { status?: string; reason?: string }
type RosterFloorResult = { leagues: RosterFloorLeague[] }

serveInternal('process-waivers', async (req) => {
  const body: Record<string, unknown> = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  const processed = await processWaiverClaims(body)
  const rosterFloor = await processRosterFloor()
  const failed = rosterFloor.leagues.filter((league) => league.status === 'failed')
  if (failed.length) {
    return Response.json({ ok: false, processed, rosterFloor }, { status: 500 })
  }
  return Response.json({ ok: true, processed, rosterFloor })
})

async function processRosterFloor(): Promise<RosterFloorResult> {
  const { data, error } = await retryDatabaseContention(() => supabase.rpc('process_roster_floor_service'), {
    failures: result => result.error ? [result.error] : [],
  })
  if (error) throw error
  return rosterFloorResult(data)
}

function rosterFloorResult(data: Json | null): RosterFloorResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { leagues: [] }
  const leagues = Array.isArray(data.leagues) ? data.leagues : []
  return {
    leagues: leagues.flatMap((league) => league && typeof league === 'object' && !Array.isArray(league)
      ? [{ status: typeof league.status === 'string' ? league.status : undefined,
          reason: typeof league.reason === 'string' ? league.reason : undefined }]
      : []),
  }
}

async function processWaiverClaims(body: Record<string, unknown>): Promise<number> {
  const startedAt = new Date().toISOString()
  const throughDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const timezone = typeof body.timezone === 'string' ? body.timezone : null
  const date = typeof body.date === 'string' ? body.date : null

  const rows = await drainDueClaims<WaiverProcessRow>(async () => {
    const { data, error } = await retryDatabaseContention(() => supabase.rpc('process_due_waiver_claims_atomic', {
      p_process_date: throughDate,
      p_limit: PROCESS_BATCH_LIMIT,
    }).select('processed'), { failures: result => result.error ? [result.error] : [] })
    if (error) throw error
    return data ?? []
  }, async () => {
    const { data, error } = await retryDatabaseContention(() => supabase.rpc('count_due_waiver_claims', { p_process_date: throughDate }), { failures: result => result.error ? [result.error] : [] })
    if (error) throw error
    return data ?? 0
  })

  const { error: expiredErr } = await retryDatabaseContention(() => supabase.rpc('expire_waiver_wire_logs'), { failures: result => result.error ? [result.error] : [] })
  if (expiredErr) throw expiredErr

  if (timezone && date) {
    const { error: settledErr } = await retryDatabaseContention(() => supabase.rpc('settle_waiver_runs', { p_timezone: timezone, p_date: date, p_drain_started_at: startedAt }), { failures: result => result.error ? [result.error] : [] })
    if (settledErr) throw settledErr
  }
  const { error: latestErr } = await retryDatabaseContention(() => supabase.rpc('settle_latest_waiver_runs', { p_drain_started_at: startedAt }), { failures: result => result.error ? [result.error] : [] })
  if (latestErr) throw latestErr

  return rows.filter((row) => row.processed).length
}
