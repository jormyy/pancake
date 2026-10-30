import { supabase } from '../../supabase/functions/_shared/supabase.ts'
import { serveInternal } from '../../supabase/functions/_shared/serve.ts'
import { drainDueClaims, PROCESS_BATCH_LIMIT } from '../../supabase/functions/process-waivers/drain.ts'

serveInternal('process-waivers', async () => {
  const processed = await processWaiverClaims()
  return Response.json({ ok: true, processed })
})

async function processWaiverClaims() {
  const throughDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

  const rows = await drainDueClaims(async () => {
    const { data, error } = await supabase.rpc('process_due_waiver_claims_atomic', {
      p_process_date: throughDate,
      p_limit: PROCESS_BATCH_LIMIT,
    })
    if (error) throw error
    return data ?? []
  }, async () => {
    const { data, error } = await supabase.rpc('count_due_waiver_claims', { p_process_date: throughDate })
    if (error) throw error
    return data ?? 0
  })

  const { error: expiredErr } = await supabase.rpc('expire_waiver_wire_logs')
  if (expiredErr) throw expiredErr

  return rows.filter((row) => row.processed).length
}
