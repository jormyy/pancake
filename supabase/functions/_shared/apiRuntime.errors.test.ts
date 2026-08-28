// The one error contract the app classifies on: a rule SQLSTATE comes back as
// a 400 with its code, whether or not the route wrapped it in throwDb; a server
// failure masks both message and code.
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'not-a-real-key-error-contract-test')
Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'edge-error-contract-test')

const { handleApiRequest, throwDb } = await import('./apiRuntime.ts')

const request = () => new Request('http://edge.test/functions/v1/api/roster/add', { method: 'POST' })

async function respond(fail: () => never) {
  const response = await handleApiRequest(request(), 'test', () => Promise.resolve().then(fail))
  return { status: response.status, body: await response.json() as { ok: boolean; error: string; code?: string; requestId: string } }
}

function expect(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

Deno.test('a rule SQLSTATE wrapped by throwDb is a 400 that keeps its code', async () => {
  const { status, body } = await respond(() => throwDb({ code: 'PA001', message: 'Weekly add limit reached (7/7 adds used this week).' }))
  expect(status, 400, 'status')
  expect(body, { ok: false, error: 'Weekly add limit reached (7/7 adds used this week).', code: 'PA001', requestId: body.requestId }, 'body')
})

Deno.test('a raw database error keeps its code too', async () => {
  const { status, body } = await respond(() => { throw { code: '23505', message: 'duplicate key value violates unique constraint "waiver_claims_member_player_key"' } })
  expect(status, 400, 'status')
  expect(body.code, '23505', 'code')
  expect(body.error, 'duplicate key value violates unique constraint "waiver_claims_member_player_key"', 'error')
})

Deno.test('a server failure masks the message and carries no code', async () => {
  const { status, body } = await respond(() => { throw new Error('connection reset') })
  expect(status, 500, 'status')
  expect(body.error, 'Internal server error', 'error')
  expect(body.code, undefined, 'code')
})
