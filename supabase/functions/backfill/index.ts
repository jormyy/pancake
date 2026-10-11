import { runBBRefChunk } from '../_shared/bbrefBackfill.ts'
import { runCDNChunk, runCDNEnumChunk } from '../_shared/cdnBackfill.ts'
import {
  BACKFILL_SOURCES,
  BackfillAdmissionError,
  type BackfillRun,
  type BackfillSource,
  backfillJobAuthority,
  beginBackfillRetry,
  claimBackfillJob,
  createBackfillJob,
  endBackfillRetry,
  failBackfillJob,
  invokeBackfill,
  releaseBackfillJob,
} from '../_shared/backfillJobs.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'

const CDN_START_YEARS = [24, 23, 22, 21, 20, 19] as const
const BBREF_SEASON_YEARS = Array.from({ length: 16 }, (_, i) => 2004 + i)

type BackfillBody = {
  action?: 'start' | 'continue' | 'retry' | 'start-all'
  source?: string
  seasonYear?: number
  jobId?: string
  offset?: number
  claimToken?: string
}

function runChunk(run: BackfillRun, offset: number): Promise<boolean> {
  if (run.source === 'cdn') return runCDNChunk(run, offset)
  if (run.source === 'cdn-enum') return runCDNEnumChunk(run, offset)
  return runBBRefChunk(run, offset)
}

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

  let body: BackfillBody = {}
  try {
    body = await req.json() as BackfillBody
    const { action, source, seasonYear, jobId, offset = 0 } = body

    if (action === 'start-all') {
      const queued = []
      for (const startYY of CDN_START_YEARS) {
        const sy = 2000 + startYY + 1
        const jid = await createBackfillJob('cdn-enum', sy)
        try {
          await invokeBackfill({ action: 'continue', source: 'cdn-enum', seasonYear: sy, jobId: jid, offset: 0 })
          queued.push({ source: 'cdn-enum', seasonYear: sy, jobId: jid, status: 'queued' })
        } catch (e) {
          await failBackfillJob(jid, e)
          queued.push({ source: 'cdn-enum', seasonYear: sy, jobId: jid, status: 'failed' })
        }
      }
      for (const sy of BBREF_SEASON_YEARS) {
        const jid = await createBackfillJob('bbref', sy)
        try {
          await invokeBackfill({ action: 'continue', source: 'bbref', seasonYear: sy, jobId: jid, offset: 0 })
          queued.push({ source: 'bbref', seasonYear: sy, jobId: jid, status: 'queued' })
        } catch (e) {
          await failBackfillJob(jid, e)
          queued.push({ source: 'bbref', seasonYear: sy, jobId: jid, status: 'failed' })
        }
      }
      return Response.json({ ok: queued.every((item) => item.status === 'queued'), queued })
    }

    if (action === 'start') {
      if (!source || !seasonYear) return Response.json({ ok: false, error: 'Missing source or seasonYear' }, { status: 400 })
      if (!BACKFILL_SOURCES.includes(source as BackfillSource)) {
        return Response.json({ ok: false, error: 'Unknown source' }, { status: 400 })
      }

      const jid = await createBackfillJob(source, seasonYear)
      try {
        await invokeBackfill({ action: 'continue', source, seasonYear, jobId: jid, offset: 0 })
      } catch (e) {
        await failBackfillJob(jid, e)
        throw e
      }
      return Response.json({ ok: true, jobId: jid })
    }

    if (action === 'continue' || action === 'retry') {
      if (!jobId) return Response.json({ ok: false, error: 'Missing jobId' }, { status: 400 })

      // The registered job, not the request, decides the season and source,
      // and only one run of a job may write at a time.
      const { job, claimToken } = await claimBackfillJob(jobId, body.claimToken ?? null)
      let handedOff = false
      try {
        const authority = backfillJobAuthority(job, { source, seasonYear })
        const run: BackfillRun = { jobId, source: authority.source, seasonYear: authority.seasonYear, claimToken, retryBefore: authority.retryBefore }
        if (action === 'retry') {
          // Queue the first retry chunk like a new start; continuations read retryBefore from the job.
          run.retryBefore = await beginBackfillRetry(run, job.metadata)
          await invokeBackfill({ action: 'continue', jobId, offset: 0, claimToken })
          handedOff = true
          return Response.json({ ok: true, jobId, retryBefore: run.retryBefore })
        }
        handedOff = await runChunk(run, offset)
        if (!handedOff && run.retryBefore) await endBackfillRetry(run, job.metadata)
      } finally {
        if (!handedOff) await releaseBackfillJob(jobId, claimToken)
      }
      return Response.json({ ok: true, jobId, offset })
    }

    return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 })
  } catch (e: unknown) {
    if (e instanceof BackfillAdmissionError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status })
    }
    if ((body.action === 'continue' || body.action === 'retry') && body.jobId) {
      try {
        await failBackfillJob(body.jobId, e)
      } catch (failError) {
        console.error('[backfill] failed to terminalize failed continuation', failError)
      }
    }
    return internalServerError('backfill', e)
  }
})
