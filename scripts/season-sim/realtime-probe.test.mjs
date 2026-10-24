import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir } from 'node:fs/promises'
import { realtimeAuth } from './realtime-probe.mjs'
import { actionClient } from './actions.mjs'
import { miniRoot, originUrl } from './common.mjs'

test('long replay subscriptions receive each refreshed local session token once', async () => {
  const published = []
  const sync = realtimeAuth({ setAuth: async token => { published.push(token) } }, 'first')
  await sync('first')
  await sync('second')
  await sync('second')
  await sync('third')
  assert.deepEqual(published, ['second', 'third'])
})

test('REST session renewal reaches Realtime before the next live sample and stops after cleanup', async t => {
  await mkdir(`${miniRoot}/evidence`, { recursive: true })
  let grants = 0
  t.mock.method(globalThis, 'fetch', async url => new Response(JSON.stringify(url.includes('/auth/v1/token?')
    ? { access_token: `renewed-${++grants}`, refresh_token: 'refresh', expires_in: 120 }
    : []), { status: 200 }))
  const user = { token: 'initial', refreshToken: 'refresh', expiresAt: 0 }
  const other = { token: 'other', refreshToken: 'refresh', expiresAt: 0 }
  const c = { ...actionClient({ API_URL: originUrl('api'), ANON_KEY: 'synthetic' }), users: [user, other] }
  const published = []
  const sync = realtimeAuth({ setAuth: async token => { published.push(token) } }, user.token, c)
  await c.rest(other, 'players?select=id&limit=0')
  await c.rest(user, 'players?select=id&limit=0')
  assert.deepEqual(published, ['renewed-2'])
  await sync(user.token)
  assert.deepEqual(published, ['renewed-2'])
  sync.close()
  user.expiresAt = 0
  await c.rest(user, 'players?select=id&limit=0')
  assert.deepEqual(published, ['renewed-2'])
})
