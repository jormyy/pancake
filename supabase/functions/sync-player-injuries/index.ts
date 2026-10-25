import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { syncInjuries } from '../sync-players/injuries.ts'

serveInternal('sync-player-injuries', async (request) => {
  const result = await recordSyncRun('sync-player-injuries', async () => {
    const injuries = await syncInjuries()
    return { result: injuries, rowsAffected: injuries.updated, failure: injuries.failure }
  }, request)
  return Response.json({ ok: !result.failure, ...result }, { status: result.failure ? 500 : 200 })
})
