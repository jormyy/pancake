import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { closeExpiredNominations } from './close.ts'

serveInternal('close-expired-nominations', async (req) => {
  const result = await recordSyncRun('close-expired-nominations', async () => {
    const result = await closeExpiredNominations()
    return { result, rowsAffected: result.checked - result.failed, failure: result.failure }
  }, req)
  return Response.json({ ok: result.failed === 0, ...result }, { status: result.failed > 0 ? 500 : 200 })
})
