import { syncStatsByDate } from '../_shared/syncStats.ts'
import { internalServerError } from '../_shared/responses.ts'

Deno.serve(async (req) => {
  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const dateStr: string = body.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const date = new Date(dateStr + 'T12:00:00Z')
    await syncStatsByDate(date)
    return Response.json({ ok: true, date: dateStr })
  } catch (e: unknown) {
    return internalServerError('sync-stats', e)
  }
})
