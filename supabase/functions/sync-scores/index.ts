import { syncScores } from '../_shared/syncScores.ts'
import { internalServerError } from '../_shared/responses.ts'

Deno.serve(async () => {
  try {
    await syncScores()
    return Response.json({ ok: true })
  } catch (e: unknown) {
    return internalServerError('sync-scores', e)
  }
})
