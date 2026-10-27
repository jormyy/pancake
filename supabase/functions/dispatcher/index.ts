import { serveInternal } from '../_shared/serve.ts'
import { supabase } from '../_shared/supabase.ts'
import { vacuumResponses } from './postgres.ts'

serveInternal('dispatcher', async request => {
  const key = request.headers.get('x-pancake-invocation-id')
  if (!key || !request.headers.get('x-pancake-work-id')) return Response.json({ error: 'Queued work required' }, { status: 400 })
  const body = await request.json()
  if (body.action === 'vacuum') {
    const databaseUrl = Deno.env.get('SUPABASE_DB_URL')
    if (!databaseUrl) throw new Error('Local database URL is not configured')
    await vacuumResponses(databaseUrl)
  } else if (body.delay === 30) {
    await new Promise(resolve => setTimeout(resolve, 30_000))
    const { error } = await supabase.rpc('run_work_maintenance', { p_invocation_key: key })
    if (error) throw error
  } else return Response.json({ error: 'Unknown work action' }, { status: 400 })
  return Response.json({ ok: true })
})
