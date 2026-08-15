import { serveInternal } from '../_shared/serve.ts'
import { defaultDraftOrderSeasonYear, syncDraftOrder } from './lib.ts'

serveInternal('sync-draft-order', async (req) => {
  const body = await readBody(req)
  const seasonYear = Number.isInteger(body.seasonYear)
    ? Number(body.seasonYear)
    : defaultDraftOrderSeasonYear()
  const result = await syncDraftOrder(seasonYear)
  return Response.json({ ok: true, ...result })
})

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
