import { syncScores } from '../_shared/syncScores.ts'

Deno.serve(async () => {
  try {
    await syncScores()
    return Response.json({ ok: true })
  } catch (e: any) {
    console.error('[sync-scores]', e)
    return Response.json({ ok: false, error: e.message }, { status: 500 })
  }
})
