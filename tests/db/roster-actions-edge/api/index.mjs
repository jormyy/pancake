import { handleApiRequest, json, routePath } from '../../../../supabase/functions/_shared/apiRuntime.ts'
import { handleLeagueRoute } from '../../../../supabase/functions/api/league.ts'
import { handleWaiverRoute } from '../../../../supabase/functions/api/waivers.ts'
import { observeDatabaseBytes } from '../../roster-actions-edge-bytes.mjs'

Object.defineProperty(crypto, 'randomUUID', { value: () => '00000000-0000-4000-8000-000000000001' })
globalThis.Deno.serve(observeDatabaseBytes()(request => handleApiRequest(request, 'api', async () => {
  const path = routePath(request)
  if (request.method === 'GET' && path === '/health') return json({ ok: true })
  return await handleLeagueRoute(request, path) ?? await handleWaiverRoute(request, path) ?? json({ ok: false, error: 'Not found' }, 404)
})))
