const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () => {
  return new Response('[]', {
    headers: {
      'content-type': 'application/json',
    },
  })
})

Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(postgrest.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
Deno.env.set('E2E_ADMIN_SECRET', 'e2e-test-secret')

const { handleApiRoute } = await import('./router.ts')

const API = 'http://localhost/functions/v1/api'
const UUID = '11111111-1111-4111-8111-111111111111'

function request(method: string, path: string): Request {
  return new Request(`${API}${path}`, {
    method,
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
  })
}

Deno.test({
  name: 'API router returns health without hitting fallback 404',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const res = await handleApiRoute(request('GET', '/health'))
    const body = await res.json()

    if (res.status !== 200 || body.runtime !== 'supabase-edge') {
      throw new Error(`expected health 200, got ${res.status}: ${JSON.stringify(body)}`)
    }
  },
})

Deno.test({
  name: 'migrated API routes are wired before the fallback 404',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const routes = [
      ['GET', '/games/today'],
      ['GET', '/players/headshot/1641705'],
      ['POST', '/league/roster/ir'],
      ['POST', '/league/roster/taxi'],
      ['POST', '/league/advance-season'],
      ['POST', '/waivers/claims'],
      ['POST', `/waivers/claims/${UUID}/cancel`],
      ['POST', '/waivers/process'],
      ['POST', '/trades/propose'],
      ['POST', `/trades/${UUID}/accept`],
      ['POST', `/trades/${UUID}/reject`],
      ['POST', `/trades/${UUID}/withdraw`],
      ['POST', `/trades/${UUID}/veto`],
      ['POST', '/draft/start'],
      ['POST', '/draft/start-rookie'],
      ['POST', `/draft/${UUID}/stop`],
      ['POST', `/draft/${UUID}/reset`],
      ['POST', `/draft/${UUID}/nominate`],
      ['POST', `/draft/${UUID}/bid`],
      ['POST', `/draft/${UUID}/withdraw-nomination`],
      ['POST', `/draft/${UUID}/snake-pick`],
      ['POST', `/draft/${UUID}/auto-pick`],
      ['POST', `/draft/${UUID}/reseed-picks`],
      ['POST', '/playoffs/generate'],
      ['POST', '/playoffs/advance'],
      ['POST', '/sync/stats'],
      ['POST', '/sync/scores'],
      ['POST', '/sync/schedule'],
      ['POST', '/sync/matchups'],
      ['POST', '/sync/players'],
      ['POST', '/sync/rankings'],
      ['POST', '/sync/projections'],
      ['POST', '/sync/draft-order'],
      ['POST', '/sync/backfill'],
      ['POST', '/sync/test-endpoints'],
      ['POST', '/sync/verify-stats'],
      ['GET', '/sync/season-totals'],
      ['POST', '/sync/validate-db'],
      ['GET', '/e2e/status'],
      ['POST', '/e2e/process-waivers'],
      ['POST', '/e2e/process-trades'],
      ['POST', '/e2e/close-expired-nominations'],
    ] as const

    const failures = []
    for (const [method, path] of routes) {
      const res = await handleApiRoute(request(method, path))
      if (res.status === 404) failures.push(`${method} ${path}`)
    }

    if (failures.length > 0) {
      throw new Error(`routes hit fallback 404: ${failures.join(', ')}`)
    }
  },
})

Deno.test({
  name: 'close API router test server',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => postgrest.shutdown(),
})
