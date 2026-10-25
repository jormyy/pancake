import { supabase } from '../_shared/supabase.ts'
import type { Database } from '../_shared/database.ts'
import { serveInternal } from '../_shared/serve.ts'
import { drainDueClaims, PROCESS_BATCH_LIMIT } from './drain.ts'

type WaiverProcessRow = Database['public']['Functions']['process_due_waiver_claims_atomic']['Returns'][number]

serveInternal('process-waivers', async () => {
  const processed = await processWaiverClaims()
  return Response.json({ ok: true, processed })
})

async function processWaiverClaims(): Promise<number> {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

  const rows = await drainDueClaims<WaiverProcessRow>(async () => {
    const { data, error } = await supabase.rpc('process_due_waiver_claims_atomic', {
      p_process_date: today,
      p_limit: PROCESS_BATCH_LIMIT,
    })
    if (error) throw error
    return data ?? []
  })

  const { error: expiredErr } = await supabase.rpc('expire_waiver_wire_logs')
  if (expiredErr) throw expiredErr

  return rows.filter((row) => row.processed).length
}
