import { syncStatsByDate } from '../_shared/syncStats.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'
import { supabase } from '../_shared/supabase.ts'
import type { Database } from '../_shared/database.ts'
import {
  parseStatsSyncJobMetadata,
  runStatsSyncJobBatch,
  type StatsSyncJobMetadata,
} from '../_shared/statsSyncJob.ts'

type SyncJob = Database['public']['Tables']['sync_jobs']['Row']

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

async function runRangeJob(jobId: string): Promise<Record<string, unknown>> {
  const { data: job, error: loadError } = await supabase
    .from('sync_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle()
  if (loadError) throw loadError
  if (!job) throw new Error('Stats sync job not found')
  if (!job.job_type.startsWith('sync_stats_range:')) throw new Error('Stats sync job type is invalid')
  if (job.status === 'completed') {
    return { jobId, status: 'completed', completedItems: job.completed_items, totalItems: job.total_items }
  }
  if (job.status === 'running') {
    return { jobId, status: 'running', completedItems: job.completed_items, totalItems: job.total_items }
  }

  const metadata = parseStatsSyncJobMetadata(job.metadata)
  const claimedMetadata = { ...metadata, claimedAt: new Date().toISOString() }
  const { data: claimed, error: claimError } = await supabase
    .from('sync_jobs')
    .update({ status: 'running', metadata: claimedMetadata })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle()
  if (claimError) throw claimError
  if (!claimed) {
    return { jobId, status: 'running', completedItems: job.completed_items, totalItems: job.total_items }
  }

  let statLines = 0
  let currentMetadata: StatsSyncJobMetadata = claimedMetadata
  let currentCompletedItems = claimed.completed_items
  try {
    const result = await recordSyncRun('sync-stats-range', async () => {
      const batch = await runStatsSyncJobBatch(
        claimedMetadata,
        claimed.completed_items,
        {
          syncDate: async (dateKey) => {
            statLines += await syncStatsByDate(new Date(`${dateKey}T12:00:00Z`))
          },
          checkpoint: async (checkpoint) => {
            currentMetadata = { ...checkpoint.metadata, claimedAt: new Date().toISOString() }
            currentCompletedItems = checkpoint.completedItems
            const { claimedAt: _claimedAt, ...releasedMetadata } = currentMetadata
            const { error } = await supabase
              .from('sync_jobs')
              .update({
                completed_items: checkpoint.completedItems,
                status: checkpoint.completed ? 'completed' : 'running',
                completed_at: checkpoint.completed ? new Date().toISOString() : null,
                metadata: checkpoint.completed ? releasedMetadata : currentMetadata,
              })
              .eq('id', jobId)
              .eq('status', 'running')
            if (error) throw error
          },
          enqueueContinuation: async () => {
            const { claimedAt: _claimedAt, ...releasedMetadata } = currentMetadata
            const { error: releaseError } = await supabase
              .from('sync_jobs')
              .update({ status: 'pending', metadata: releasedMetadata })
              .eq('id', jobId)
              .eq('status', 'running')
            if (releaseError) throw releaseError
            const { error: invokeError } = await supabase.rpc('invoke_edge_function', {
              function_name: 'sync-stats',
              body: { jobId },
            })
            if (invokeError) throw invokeError
          },
        },
      )
      return { result: batch, rowsAffected: statLines }
    })
    return {
      jobId,
      status: result.completed ? 'completed' : 'queued',
      completedItems: result.completedItems,
      totalItems: claimed.total_items,
      statLines,
    }
  } catch (error) {
    await failRangeJob(claimed, currentMetadata, currentCompletedItems, error)
    throw error
  }
}

async function failRangeJob(
  job: SyncJob,
  metadata: ReturnType<typeof parseStatsSyncJobMetadata>,
  completedItems: number,
  error: unknown,
): Promise<void> {
  const existingLog = Array.isArray(job.error_log) ? job.error_log : []
  const { claimedAt: _claimedAt, ...releasedMetadata } = metadata
  const { error: updateError } = await supabase
    .from('sync_jobs')
    .update({
      status: 'failed',
      completed_items: completedItems,
      failed_items: job.failed_items + 1,
      error_log: [...existingLog, errorMessage(error)].slice(-100),
      completed_at: new Date().toISOString(),
      metadata: releasedMetadata,
    })
    .eq('id', job.id)
    .eq('status', 'running')
  if (updateError) console.error('[sync-stats] could not persist range job failure', updateError)
}

serveInternal('sync-stats', async (req) => {
  const body: Record<string, unknown> = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  if (typeof body.jobId === 'string') return Response.json({ ok: true, ...await runRangeJob(body.jobId) })
  const dateStr = typeof body.date === 'string'
    ? body.date
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const date = new Date(dateStr + 'T12:00:00Z')
  const statLines = await recordSyncRun('sync-stats', async () => {
    const statLines = await syncStatsByDate(date)
    return { result: statLines, rowsAffected: statLines }
  })
  return Response.json({ ok: true, date: dateStr, statLines })
})
