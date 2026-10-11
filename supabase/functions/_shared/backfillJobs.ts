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
// A chunk of 30 paced games finishes well inside this; a crashed chunk frees the job after it.
const BACKFILL_CLAIM_LEASE_MS = 5 * 60_000

export const BACKFILL_SOURCES = ['cdn', 'cdn-enum', 'bbref'] as const
export type BackfillSource = typeof BACKFILL_SOURCES[number]

/** One admitted run of a registered job: stored source/season, the held claim, and an explicit-retry cutoff. */
export type BackfillRun = {
  jobId: string
  source: BackfillSource
  seasonYear: number
  claimToken: string
  retryBefore: string | null
}

type StoredBackfillJob = { id: string; job_type: string; metadata: Json | null }

export class BackfillAdmissionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function jobMetadata(job: StoredBackfillJob): Record<string, unknown> {
  return job.metadata && typeof job.metadata === 'object' && !Array.isArray(job.metadata)
    ? job.metadata as Record<string, unknown>
    : {}
}

/** The registered job's stored source and season are authoritative; a request may only restate them. */
export function backfillJobAuthority(
  job: StoredBackfillJob,
  supplied: { source?: unknown; seasonYear?: unknown },
): { source: BackfillSource; seasonYear: number; retryBefore: string | null } {
  const metadata = jobMetadata(job)
  const source = metadata.source as BackfillSource
  const seasonYear = metadata.seasonYear
  if (!BACKFILL_SOURCES.includes(source) || !Number.isInteger(seasonYear) ||
      job.job_type !== `backfill_${source}_${seasonYear}`) {
    throw new BackfillAdmissionError('Job is not a registered backfill job', 409)
  }
  if ((supplied.source != null && supplied.source !== source) ||
      (supplied.seasonYear != null && supplied.seasonYear !== seasonYear)) {
    throw new BackfillAdmissionError(`Request does not match registered backfill job ${source} ${seasonYear}`, 409)
  }
  return {
    source,
    seasonYear: seasonYear as number,
    retryBefore: typeof metadata.retryBefore === 'string' ? metadata.retryBefore : null,
  }
}

/**
 * Admit one run per job: claim a free or stale job, or take over the claim a
 * previous chunk handed to its continuation. Overlapping calls are refused
 * before any write instead of repeating the same fetches and upserts.
 */
export async function claimBackfillJob(
  jobId: string,
  handoffToken: string | null,
): Promise<{ job: StoredBackfillJob; claimToken: string }> {
  const claimToken = crypto.randomUUID()
  const staleBefore = new Date(Date.now() - BACKFILL_CLAIM_LEASE_MS).toISOString()
  // Each conditional update re-checks its predicate under the row lock, so at
  // most one caller wins a given job state. (PostgREST rejects or= on updates.)
  const claim = () =>
    supabase
      .from('sync_jobs')
      .update({ claim_token: claimToken, claimed_at: new Date().toISOString() })
      .eq('id', jobId)
      .like('job_type', 'backfill_%')
  // Builders run only when awaited, in order.
  const attempts = [
    claim().is('claim_token', null),
    ...(handoffToken ? [claim().eq('claim_token', handoffToken)] : []),
    claim().lt('claimed_at', staleBefore),
  ]
  for (const attempt of attempts) {
    const claimed = await mustSupabase('claim backfill job', attempt.select('id, job_type, metadata'))
    if (claimed?.length === 1) return { job: claimed[0] as StoredBackfillJob, claimToken }
  }

  const existing = await mustSupabase(
    'load backfill job',
    supabase.from('sync_jobs').select('id').eq('id', jobId).like('job_type', 'backfill_%').maybeSingle(),
  )
  if (!existing) throw new BackfillAdmissionError('Backfill job not found', 404)
  throw new BackfillAdmissionError('Backfill job is already running', 409)
}

export async function releaseBackfillJob(jobId: string, claimToken: string): Promise<void> {
  await mustSupabase(
    'release backfill job',
    supabase.from('sync_jobs').update({ claim_token: null, claimed_at: null }).eq('id', jobId).eq('claim_token', claimToken),
  )
}

/** Explicit retry: reopen the same job and rerun only games that had failed before now. */
export async function beginBackfillRetry(run: BackfillRun, metadata: Json | null): Promise<string> {
  const retryBefore = new Date().toISOString()
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  await mustSupabase(
    'begin backfill retry',
    supabase
      .from('sync_jobs')
      .update({ status: 'pending', completed_at: null, metadata: { ...base, retryBefore } })
      .eq('id', run.jobId)
      .eq('claim_token', run.claimToken),
  )
  return retryBefore
}

export async function endBackfillRetry(run: BackfillRun, metadata: Json | null): Promise<void> {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {}
  delete (base as Record<string, unknown>).retryBefore
  await mustSupabase(
    'end backfill retry',
    supabase.from('sync_jobs').update({ metadata: base }).eq('id', run.jobId).eq('claim_token', run.claimToken),
  )
}

export async function loadBackfillRetryGameKeys(run: BackfillRun): Promise<Set<string>> {
  const keys = new Set<string>()
  let page = 0
  while (true) {
    const rows = await mustSupabase(
      'load failed backfill games for retry',
      supabase
        .from('backfill_game_attempts')
        .select('game_key')
        .eq('job_id', run.jobId)
        .eq('source', run.source)
        .eq('status', 'failed')
        .lt('updated_at', run.retryBefore!)
        .order('game_key')
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1),
    )
    if (!rows?.length) break
    for (const row of rows as { game_key: string }[]) keys.add(row.game_key)
    if (rows.length < PAGE_SIZE) break
    page++
  }
  return keys
}

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
