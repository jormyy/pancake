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
import { parseStatsSyncJobMetadata, statsSyncRange } from '../_shared/statsSyncJob.ts'

async function requireAdminUser(req: Request): Promise<void> {
  const userId = await requireUser(req)
  requireAdmin(userId)
}

async function syncStats(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const days = optionalIntegerField(body, 'days', { min: 1, max: 365 }) ?? 1
  const range = statsSyncRange(todayET(), days)
  const jobType = `sync_stats_range:${range.startDate}:${range.endDate}`
  const { data: existingJobs, error: existingError } = await supabase
    .from('sync_jobs')
    .select('id, status, metadata')
    .eq('job_type', jobType)
    .in('status', ['pending', 'running', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1)
  if (existingError) throwDb(existingError)

  let jobId = existingJobs?.[0]?.id
  if (jobId) {
    const existing = existingJobs[0]
    const metadata = parseStatsSyncJobMetadata(existing.metadata)
    const claimedAt = metadata.claimedAt ? Date.parse(metadata.claimedAt) : Number.NaN
    const staleRunningJob = existing.status === 'running' &&
      (!Number.isFinite(claimedAt) || claimedAt < Date.now() - 2 * 60_000)
    if (existing.status === 'failed' || staleRunningJob) {
      const { claimedAt: _claimedAt, ...releasedMetadata } = metadata
      const { error } = await supabase
        .from('sync_jobs')
        .update({ status: 'pending', completed_at: null, metadata: releasedMetadata })
        .eq('id', jobId)
        .eq('status', existing.status)
        .contains('metadata', metadata.claimedAt ? { claimedAt: metadata.claimedAt } : {})
      if (error) throwDb(error)
    }
  } else {
    const { data: created, error } = await supabase
      .from('sync_jobs')
      .insert({
        job_type: jobType,
        status: 'pending',
        total_items: days,
        completed_items: 0,
        failed_items: 0,
        error_log: [],
        metadata: range,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error) throwDb(error)
    jobId = created.id
  }

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
  if (path === '/sync/rankings') return json(await invokeInternalFunction('sync-rankings'))
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
