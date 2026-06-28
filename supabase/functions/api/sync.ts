import {
  invokeInternalFunction,
  assertUuid,
  json,
  optionalIntegerField,
  optionalStringField,
  readJsonObject,
  requireAdmin,
  requireUser,
  throwDb,
  uuidField,
} from '../_shared/apiRuntime.ts'
import { supabase } from '../_shared/supabase.ts'
import { generateAllMatchups } from './matchups.ts'

function dateStringForDaysAgo(daysAgo: number): string {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

async function requireAdminUser(req: Request): Promise<void> {
  const userId = await requireUser(req)
  requireAdmin(userId)
}

async function syncStats(body: Record<string, unknown>): Promise<void> {
  const days = optionalIntegerField(body, 'days', { min: 1, max: 365 }) ?? 1
  for (let i = days - 1; i >= 0; i -= 1) {
    await invokeInternalFunction('sync-stats', { date: dateStringForDaysAgo(i) })
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
    await syncStats(body)
    return json({ ok: true })
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
  if (path === '/sync/matchups') {
    const leagueId = typeof body.leagueId === 'string' ? uuidField(body, 'leagueId') : undefined
    await generateAllMatchups(Boolean(body.force), leagueId)
    return json({ ok: true })
  }

  return null
}
