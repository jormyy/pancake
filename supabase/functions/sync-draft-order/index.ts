import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { defaultDraftOrderSeasonYear, syncDraftOrder } from './lib.ts'

serveInternal('sync-draft-order', async (req) => {
  const body = await readBody(req)
  const seasonYear = Number.isInteger(body.seasonYear)
    ? Number(body.seasonYear)
    : defaultDraftOrderSeasonYear()
  const result = await recordSyncRun('sync-draft-order', async () => {
    const draftOrder = await syncDraftOrder(seasonYear)
    return {
      result: draftOrder,
      rowsAffected: draftOrder.updated + draftOrder.staleDraftNumbersCleared,
    }
  })
  return Response.json({ ok: true, ...result })
})

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
