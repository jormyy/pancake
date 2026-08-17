import {
  invokeInternalFunction,
  assertUuid,
  json,
  isAdmin,
  optionalIntegerField,
  optionalStringField,
  readJsonObject,
  requireAdmin,
  requireCommissioner,
  requireUser,
  throwDb,
  uuidField,
} from '../_shared/apiRuntime.ts'
import { supabase } from '../_shared/supabase.ts'
import { generateAllMatchups } from './matchups.ts'
import { todayET } from '../_shared/date.ts'
import { statsSyncRange } from '../_shared/statsSyncJob.ts'

const DYNASTY_RANKING_VIEWS = ['CONTEND', 'REBUILD', 'ROOKIE', 'OVERALL'] as const

async function requireAdminUser(req: Request): Promise<void> {
  const userId = await requireUser(req)
  requireAdmin(userId)
}

async function syncStats(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const days = optionalIntegerField(body, 'days', { min: 1, max: 365 }) ?? 1
  const range = statsSyncRange(todayET(), days)
  const { data: jobId, error } = await supabase.rpc('create_or_resume_stats_sync_job_atomic', {
    p_start_date: range.startDate,
    p_end_date: range.endDate,
  })
  if (error) throwDb(error)
  if (!jobId) throw new Error('Stats sync job creation returned no id')

  const result = await invokeInternalFunction('sync-stats', { jobId })
  return {
    jobId,
    days,
    ...(result && typeof result === 'object' && !Array.isArray(result) ? result : {}),
  }
}

async function syncBackfill(body: Record<string, unknown>): Promise<unknown> {
  const seasonYear = optionalIntegerField(body, 'seasonYear', { min: 1946, max: 2100 })
  if (!seasonYear) {
    return await invokeInternalFunction('backfill', { action: 'start-all' })
  }
  return await invokeInternalFunction('backfill', {
    action: 'start',
    source: optionalStringField(body, 'source') ?? 'cdn',
    seasonYear,
  })
}

async function syncRankings(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requested = optionalStringField(body, 'view')?.toUpperCase() ?? 'OVERALL'
  if (!DYNASTY_RANKING_VIEWS.some((view) => view === requested)) {
    throw new Error(`Unknown ranking view: ${requested}`)
  }
  return await invokeInternalFunction('sync-rankings', { view: requested }) as Record<string, unknown>
}

async function backfillProgress(jobId: string): Promise<unknown> {
  const { data, error } = await supabase
    .from('sync_jobs')
    .select('*')
    .eq('id', jobId)
    .single()
  if (error) throwDb(error)
  return data
}

export async function handleSyncRoute(req: Request, path: string): Promise<Response | null> {
  if (!path.startsWith('/sync/')) return null

  if (req.method === 'POST' && path === '/sync/matchups') {
    const body = await readJsonObject(req)
    const leagueId = uuidField(body, 'leagueId')
    const userId = await requireUser(req)
    if (!isAdmin(userId)) await requireCommissioner(userId, leagueId)
    await generateAllMatchups(Boolean(body.force), leagueId)
    return json({ ok: true })
  }

  await requireAdminUser(req)

  if (req.method === 'GET') {
    const backfillMatch = path.match(/^\/sync\/backfill\/([^/]+)$/)
    if (backfillMatch) {
      assertUuid(backfillMatch[1], 'jobId')
      return json(await backfillProgress(backfillMatch[1]))
    }

    if (path === '/sync/season-totals') {
      const url = new URL(req.url)
      const seasonYear = url.searchParams.get('seasonYear')
      return json(await invokeInternalFunction('verify', {}, {
        method: 'GET',
        query: { action: 'season-totals', seasonYear },
      }))
    }

    return null
  }

  if (req.method !== 'POST') return null
  const body = await readJsonObject(req)

  if (path === '/sync/stats') {
    return json({ ok: true, ...await syncStats(body) })
  }
  if (path === '/sync/scores') return json(await invokeInternalFunction('sync-scores'))
  if (path === '/sync/schedule') return json(await invokeInternalFunction('sync-schedule'))
  if (path === '/sync/players') return json(await invokeInternalFunction('sync-players'))
  if (path === '/sync/rankings') return json(await syncRankings(body))
  if (path === '/sync/projections') return json(await invokeInternalFunction('sync-projections'))
  if (path === '/sync/draft-order') return json(await invokeInternalFunction('sync-draft-order', body))
  if (path === '/sync/backfill') return json(await syncBackfill(body))
  if (path === '/sync/test-endpoints') {
    return json(await invokeInternalFunction('verify', { action: 'test-endpoints' }))
  }
  if (path === '/sync/verify-stats') {
    return json(await invokeInternalFunction('verify', { action: 'season-totals', seasonYear: body.seasonYear }))
  }
  if (path === '/sync/validate-db') {
    return json(await invokeInternalFunction('verify', { action: 'validate-db', seasonYear: body.seasonYear }))
  }
  return null
}
