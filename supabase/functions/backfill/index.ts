import { runBBRefChunk } from '../_shared/bbrefBackfill.ts'
import { runCDNChunk, runCDNEnumChunk } from '../_shared/cdnBackfill.ts'
import { createBackfillJob, failBackfillJob, invokeBackfill } from '../_shared/backfillJobs.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'

const CDN_START_YEARS = [24, 23, 22, 21, 20, 19] as const
const BBREF_SEASON_YEARS = Array.from({ length: 16 }, (_, i) => 2004 + i)

type BackfillBody = {
  action?: 'start' | 'continue' | 'start-all'
  source?: string
  seasonYear?: number
  jobId?: string
  offset?: number
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

      const jid = await createBackfillJob(source, seasonYear)
      try {
        await invokeBackfill({ action: 'continue', source, seasonYear, jobId: jid, offset: 0 })
      } catch (e) {
        await failBackfillJob(jid, e)
        throw e
      }
      return Response.json({ ok: true, jobId: jid })
    }

    if (action === 'continue') {
      if (!source || !seasonYear || !jobId) {
        return Response.json({ ok: false, error: 'Missing source, seasonYear, or jobId' }, { status: 400 })
      }

      if (source === 'cdn') {
        await runCDNChunk(seasonYear, jobId, offset)
      } else if (source === 'cdn-enum') {
        await runCDNEnumChunk(seasonYear, jobId, offset)
      } else if (source === 'bbref') {
        await runBBRefChunk(seasonYear, jobId, offset)
      } else {
        return Response.json({ ok: false, error: 'Unknown source' }, { status: 400 })
      }
      return Response.json({ ok: true, jobId, offset })
    }

    return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 })
  } catch (e: unknown) {
    if (body.action === 'continue' && body.jobId) {
      try {
        await failBackfillJob(body.jobId, e)
      } catch (failError) {
        console.error('[backfill] failed to terminalize failed continuation', failError)
      }
    }
    return internalServerError('backfill', e)
  }
})
