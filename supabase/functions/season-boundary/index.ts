import { runSeasonBoundary } from '../_shared/seasonBoundary.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'

serveInternal('season-boundary', async (req) => {
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  const leagueId = typeof body.leagueId === 'string' ? body.leagueId : undefined
  const date = typeof body.date === 'string' ? new Date(body.date) : null
  const referenceDate = date && !Number.isNaN(date.getTime()) ? date : new Date()

  let reports: Awaited<ReturnType<typeof runSeasonBoundary>> = []
  await recordSyncRun('season-boundary', async () => {
    reports = await runSeasonBoundary(referenceDate, leagueId)
    return { result: undefined, rowsAffected: reports.length }
  })
  return Response.json({ ok: true, leagues: reports })
})
