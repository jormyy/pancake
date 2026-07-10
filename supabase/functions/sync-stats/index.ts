import { syncStatsByDate, findNextStatsGame, syncStatsGame, type StatsSyncGame } from '../_shared/syncStats.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'
import { supabase } from '../_shared/supabase.ts'
import type { Database, Json } from '../_shared/database.ts'
import {
  parseStatsSyncJobMetadata,
  runStatsSyncJobUnit,
  type StatsSyncJobMetadata,
} from '../_shared/statsSyncJob.ts'

type StatsSyncClaim = Database['public']['Functions']['claim_stats_sync_job_atomic']['Returns'][number]

class StatsSyncClaimLostError extends Error {
  constructor(action: string) {
    super(`Stats sync claim was superseded before ${action}`)
  }
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

function metadataJson(metadata: StatsSyncJobMetadata): Json {
  return {
    startDate: metadata.startDate,
    endDate: metadata.endDate,
    nextDate: metadata.nextDate,
    ...(metadata.afterGameId ? { afterGameId: metadata.afterGameId } : {}),
  }
}

function failureMetadataJson(metadata: Json, jobType: string): Json {
  const match = jobType.match(/^sync_stats_range:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/)
  if (!match) throw new Error('Stats sync job type is invalid')
  return {
    startDate: match[1],
    endDate: match[2],
    nextDate: match[1],
    invalidMetadata: metadata,
  }
}

async function claimRangeJob(jobId?: string): Promise<StatsSyncClaim | null> {
  const { data, error } = await supabase.rpc('claim_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_stale_after_seconds: 120,
  })
  if (error) throw error
  return data?.[0] ?? null
}

async function requireFencedTransition(
  action: string,
  operation: PromiseLike<{ data: boolean | null; error: { message: string } | null }>,
): Promise<void> {
  const { data, error } = await operation
  if (error) throw error
  if (data !== true) throw new StatsSyncClaimLostError(action)
}

async function runClaimedRangeJob(claim: StatsSyncClaim): Promise<Record<string, unknown>> {
  let currentMetadata: StatsSyncJobMetadata | null = null
  let currentCompletedItems = claim.completed_items
  let statLines = 0
  let selectedGame: StatsSyncGame | null = null

  try {
    const metadata = parseStatsSyncJobMetadata(claim.metadata)
    currentMetadata = metadata
    const result = await recordSyncRun('sync-stats-range', async () => {
      const unit = await runStatsSyncJobUnit(metadata, claim.completed_items, {
        findNextGame: async (dateKey, afterGameId) => {
          selectedGame = await findNextStatsGame(dateKey, afterGameId)
          return selectedGame?.id ?? null
        },
        syncGame: async (gameId) => {
          if (!selectedGame || selectedGame.id !== gameId) {
            throw new Error('Stats sync selected game changed before processing')
          }
          statLines = await syncStatsGame(selectedGame)
        },
        checkpoint: async (completedItems, nextMetadata) => {
          currentCompletedItems = completedItems
          currentMetadata = nextMetadata
          await requireFencedTransition(
            'checkpoint',
            supabase.rpc('checkpoint_stats_sync_job_atomic', {
              p_job_id: claim.id,
              p_claim_token: claim.claim_token,
              p_completed_items: completedItems,
              p_metadata: metadataJson(nextMetadata),
            }),
          )
        },
        release: async (completedItems, nextMetadata) => {
          currentCompletedItems = completedItems
          currentMetadata = nextMetadata
          await requireFencedTransition(
            'release',
            supabase.rpc('release_stats_sync_job_atomic', {
              p_job_id: claim.id,
              p_claim_token: claim.claim_token,
              p_completed_items: completedItems,
              p_metadata: metadataJson(nextMetadata),
            }),
          )
        },
        complete: async (completedItems, nextMetadata) => {
          currentCompletedItems = completedItems
          currentMetadata = nextMetadata
          await requireFencedTransition(
            'completion',
            supabase.rpc('complete_stats_sync_job_atomic', {
              p_job_id: claim.id,
              p_claim_token: claim.claim_token,
              p_completed_items: completedItems,
              p_metadata: metadataJson(nextMetadata),
            }),
          )
        },
      })
      return { result: unit, rowsAffected: statLines }
    })

    if (!result.completed) await kickStatsDispatcher()
    return {
      jobId: claim.id,
      status: result.completed ? 'completed' : 'queued',
      completedItems: result.completedItems,
      totalItems: claim.total_items,
      statLines,
    }
  } catch (error) {
    if (error instanceof StatsSyncClaimLostError) {
      return {
        jobId: claim.id,
        status: 'superseded',
        completedItems: currentCompletedItems,
        totalItems: claim.total_items,
        statLines,
      }
    }
    await failRangeJob(
      claim,
      currentMetadata ? metadataJson(currentMetadata) : failureMetadataJson(claim.metadata, claim.job_type),
      currentCompletedItems,
      error,
    )
    throw error
  }
}

async function failRangeJob(
  claim: StatsSyncClaim,
  metadata: Json,
  completedItems: number,
  error: unknown,
): Promise<void> {
  const { data, error: updateError } = await supabase.rpc('fail_stats_sync_job_atomic', {
    p_job_id: claim.id,
    p_claim_token: claim.claim_token,
    p_completed_items: completedItems,
    p_metadata: metadata,
    p_error: errorMessage(error),
  })
  if (updateError) {
    console.error('[sync-stats] could not persist range job failure', updateError)
  } else if (data !== true) {
    console.warn('[sync-stats] range job failure ignored because its claim was superseded', claim.id)
  }
}

async function kickStatsDispatcher(): Promise<void> {
  const { error } = await supabase.rpc('invoke_edge_function', {
    function_name: 'sync-stats',
    body: { dispatch: true },
  })
  if (error) console.warn('[sync-stats] immediate dispatcher kick failed; cron will retry', error)
}

async function runRangeJob(jobId?: string): Promise<Record<string, unknown>> {
  const claim = await claimRangeJob(jobId)
  if (claim) return runClaimedRangeJob(claim)

  if (jobId) {
    const { data: job, error } = await supabase
      .from('sync_jobs')
      .select('status, completed_items, total_items')
      .eq('id', jobId)
      .maybeSingle()
    if (error) throw error
    if (!job) throw new Error('Stats sync job not found')
    return {
      jobId,
      status: job.status,
      completedItems: job.completed_items,
      totalItems: job.total_items,
    }
  }

  return { status: 'idle' }
}

serveInternal('sync-stats', async (req) => {
  const body: Record<string, unknown> = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  if (body.dispatch === true) return Response.json({ ok: true, ...await runRangeJob() })
  if (typeof body.jobId === 'string') return Response.json({ ok: true, ...await runRangeJob(body.jobId) })

  const dateStr = typeof body.date === 'string'
    ? body.date
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const date = new Date(dateStr + 'T12:00:00Z')
  const statLines = await recordSyncRun('sync-stats', async () => {
    const rows = await syncStatsByDate(date)
    return { result: rows, rowsAffected: rows }
  })
  return Response.json({ ok: true, date: dateStr, statLines })
})
