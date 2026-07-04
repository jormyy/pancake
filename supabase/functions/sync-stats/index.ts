import { syncStatsByDate } from '../_shared/syncStats.ts'
import { serveInternal } from '../_shared/serve.ts'

serveInternal('sync-stats', async (req) => {
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  const dateStr: string = body.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const date = new Date(dateStr + 'T12:00:00Z')
  await syncStatsByDate(date)
  return Response.json({ ok: true, date: dateStr })
})
