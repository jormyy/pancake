import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { refreshViews } from './work.ts'

serveInternal('refresh-views', async request => {
  const result = await recordSyncRun('refresh-views', refreshViews, request)
  return Response.json({ ok: result.failures.length === 0, ...result }, { status: result.failures.length ? 500 : 200 })
})
