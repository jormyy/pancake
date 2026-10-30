import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { refreshViews } from './work.ts'
import { refreshTradeWork } from './trades.ts'
import { runScheduledChunks } from './scheduled.ts'

serveInternal('refresh-views', async request => {
  const body = await request.json().catch(() => ({}))
  if (body.schedulerChunk) {
    const result = await recordSyncRun('scheduler-chunk', () => runScheduledChunks(body.schedulerChunk, body.at), request)
    return Response.json({ ok: true, ...result })
  }
  if (body.revaluationScan || body.tradeId) {
    const result = await recordSyncRun('trade-revaluation', () => refreshTradeWork(body), request)
    return Response.json({ ok: true, ...result })
  }
  const result = await recordSyncRun('refresh-views', refreshViews, request)
  return Response.json({ ok: result.failures.length === 0, ...result }, { status: result.failures.length ? 500 : 200 })
})
