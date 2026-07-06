import { supabase } from './supabase.ts'
import type { Database, Json } from './database.ts'

type SyncJobUpdate = Database['public']['Tables']['sync_jobs']['Update']
type BackfillGameAttemptInsert = Database['public']['Tables']['backfill_game_attempts']['Insert']
type SupabaseResult<T> = {
  data: T
  error: { message: string } | null
}
type BackfillLedgerProgress = {
  completed_items: number
  failed_items: number
  missing_items: number
}
const PAGE_SIZE = 1000

export async function mustSupabase<T>(
  label: string,
  resultOrPromise: SupabaseResult<T> | PromiseLike<SupabaseResult<T>>,
): Promise<T> {
  const result = await resultOrPromise
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

export async function createBackfillJob(source: string, seasonYear: number): Promise<string> {
  const { data, error } = await supabase
    .from('sync_jobs')
    .insert({
      job_type: `backfill_${source}_${seasonYear}`,
      status: 'pending',
      completed_items: 0,
      failed_items: 0,
      error_log: [],
      metadata: { source, seasonYear },
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function invokeBackfill(body: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc('invoke_edge_function', {
    function_name: 'backfill',
    body: body as Json,
  })
  if (error) throw new Error(`backfill self-invocation failed: ${error.message}`)
}

export async function failBackfillJob(jobId: string, error: unknown): Promise<void> {
  const message = String(error instanceof Error ? error.message : error)
  const existing = await mustSupabase(
    'load backfill job before failing',
    supabase
      .from('sync_jobs')
      .select('error_log, failed_items')
      .eq('id', jobId)
      .maybeSingle(),
  )
  const existingLog = Array.isArray(existing?.error_log) ? existing.error_log : []
  await updateBackfillJob(jobId, {
    status: 'failed',
    failed_items: Math.max(existing?.failed_items ?? 0, 1),
    error_log: [...existingLog, message].slice(-100) as Json,
    completed_at: new Date().toISOString(),
  })
}

export async function updateBackfillJob(jobId: string, patch: SyncJobUpdate): Promise<void> {
  const { error } = await supabase.from('sync_jobs').update(patch).eq('id', jobId)
  if (error) throw error
}

export async function completeBackfillJobFromLedger(jobId: string, source: string): Promise<void> {
  await syncBackfillLedgerProgress(jobId, source, true)
}

export async function syncBackfillLedgerProgress(
  jobId: string,
  source: string,
  final = false,
): Promise<BackfillLedgerProgress> {
  const progress = await loadBackfillLedgerProgress(jobId, source)
  await updateBackfillJob(jobId, {
    completed_items: progress.completed_items,
    failed_items: progress.failed_items,
    ...(final
      ? {
        status: progress.failed_items > 0 ? 'completed_with_errors' : 'completed',
        completed_at: new Date().toISOString(),
      }
      : { status: 'pending' }),
  })
  return progress
}

export async function loadBackfillTerminalGameKeys(jobId: string, source: string): Promise<Set<string>> {
  const keys = new Set<string>()
  let page = 0

  while (true) {
    const rows = await mustSupabase(
      'load backfill game ledger',
      supabase
        .from('backfill_game_attempts')
        .select('game_key')
        .eq('job_id', jobId)
        .eq('source', source)
        .in('status', ['completed', 'failed', 'missing'])
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1),
    )

    if (!rows?.length) break
    for (const row of rows as { game_key: string }[]) keys.add(row.game_key)
    if (rows.length < PAGE_SIZE) break
    page++
  }

  return keys
}

async function loadBackfillLedgerProgress(jobId: string, source: string): Promise<BackfillLedgerProgress> {
  const progress = { completed_items: 0, failed_items: 0, missing_items: 0 }
  let page = 0

  while (true) {
    const rows = await mustSupabase(
      'load backfill game ledger progress',
      supabase
        .from('backfill_game_attempts')
        .select('status')
        .eq('job_id', jobId)
        .eq('source', source)
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1),
    )

    if (!rows?.length) break
    for (const row of rows as { status: string }[]) {
      if (row.status === 'completed') progress.completed_items++
      if (row.status === 'failed') progress.failed_items++
      if (row.status === 'missing') progress.missing_items++
    }
    if (rows.length < PAGE_SIZE) break
    page++
  }

  return progress
}

export async function markBackfillGameCompleted(
  jobId: string,
  source: string,
  seasonYear: number,
  gameKey: string,
  gameDbId?: string | null,
): Promise<void> {
  await recordBackfillGameAttempt(jobId, source, seasonYear, gameKey, 'completed', null, gameDbId)
}

export async function markBackfillGameFailed(
  jobId: string,
  source: string,
  seasonYear: number,
  gameKey: string,
  error: unknown,
  gameDbId?: string | null,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await recordBackfillGameAttempt(jobId, source, seasonYear, gameKey, 'failed', message, gameDbId)
}

export async function markBackfillGameMissing(
  jobId: string,
  source: string,
  seasonYear: number,
  gameKey: string,
  gameDbId?: string | null,
): Promise<void> {
  await recordBackfillGameAttempt(jobId, source, seasonYear, gameKey, 'missing', null, gameDbId)
}

async function recordBackfillGameAttempt(
  jobId: string,
  source: string,
  seasonYear: number,
  gameKey: string,
  status: 'completed' | 'failed' | 'missing',
  lastError: string | null,
  gameDbId?: string | null,
): Promise<void> {
  const row: BackfillGameAttemptInsert = {
    job_id: jobId,
    source,
    season_year: seasonYear,
    game_key: gameKey,
    game_db_id: gameDbId ?? null,
    status,
    attempts: 1,
    last_error: lastError,
    updated_at: new Date().toISOString(),
  }

  await mustSupabase(
    `record ${source} backfill result for ${gameKey}`,
    supabase
      .from('backfill_game_attempts')
      .upsert(row, { onConflict: 'job_id,source,game_key' }),
  )
}
