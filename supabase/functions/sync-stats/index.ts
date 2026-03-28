import { syncStatsByDate } from '../_shared/syncStats.ts'

Deno.serve(async (req) => {
  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const dateStr: string = body.date ?? new Date().toISOString().split('T')[0]
    const date = new Date(dateStr + 'T12:00:00Z')
    await syncStatsByDate(date)
    return Response.json({ ok: true, date: dateStr })
  } catch (e: any) {
    console.error('[sync-stats]', e)
    return Response.json({ ok: false, error: e.message }, { status: 500 })
  }
})
