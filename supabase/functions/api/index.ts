import { json, handleApiRequest, routePath } from '../_shared/apiRuntime.ts'
import { handleDraftRoute } from './draft.ts'
import { handleE2eRoute } from './e2e.ts'
import { handleGamesRoute } from './games.ts'
import { handleLeagueRoute } from './league.ts'
import { handlePlayoffRoute } from './playoffs.ts'
import { handleSyncRoute } from './sync.ts'
import { handleTradeRoute } from './trades.ts'
import { handleWaiverRoute } from './waivers.ts'

Deno.serve((req) => handleApiRequest(req, 'api', async () => {
  const path = routePath(req)

  if (req.method === 'GET' && path === '/health') {
    return json({
      ok: true,
      service: 'pancake-supabase-api',
      runtime: 'supabase-edge',
    })
  }

  const route =
    await handleE2eRoute(req, path) ??
    await handleGamesRoute(req, path) ??
    await handleLeagueRoute(req, path) ??
    await handleWaiverRoute(req, path) ??
    await handleTradeRoute(req, path) ??
    await handleDraftRoute(req, path) ??
    await handlePlayoffRoute(req, path) ??
    await handleSyncRoute(req, path)

  return route ?? json({ ok: false, error: 'Not found' }, 404)
}))
