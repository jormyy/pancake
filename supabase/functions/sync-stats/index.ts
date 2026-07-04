import { syncStatsByDate } from '../_shared/syncStats.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'

serveInternal('sync-stats', async (req) => {
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  const dateStr: string = body.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const date = new Date(dateStr + 'T12:00:00Z')
  const statLines = await recordSyncRun('sync-stats', async () => {
    const statLines = await syncStatsByDate(date)
    return { result: statLines, rowsAffected: statLines }
  })
  return Response.json({ ok: true, date: dateStr, statLines })
})
