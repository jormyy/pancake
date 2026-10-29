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

test('the draft-only probe verifies a row event and restores its setup draft', async () => {
  const { startDraftProbe } = await import('./realtime-probe.mjs')
  const draft = '00000000-0000-4000-8000-000000000001'
  let timer = 90, receive, removed = 0
  const c = { leagueId: draft, users: [{ token: 'local' }], onTokenRefresh: () => () => {}, rest: async () => [{ id: draft, pick_timer_seconds: timer }] }
  const probe = await startDraftProbe(c, {}, {
    clientFactory: () => ({ setAuth: async () => {}, subscribe(_topic, filter, callback, status, ready) { assert.equal(filter.table, 'drafts'); receive = callback; status('SUBSCRIBED'); ready() }, close: async () => { removed++ } }),
    execute: async statement => { timer = Number(/pick_timer_seconds=(\d+)/.exec(statement)[1]); receive({ new: { id: draft, pick_timer_seconds: timer }, commit_timestamp: '2026-10-28T10:00:00Z' }) },
    pause: async () => {},
  })
  assert.equal(probe.readyToVerify(), true)
  assert.equal(timer, 90)
  assert.equal((await probe.verify()).passed, true)
  await probe.close()
  assert.equal(removed, 1)
})

test('a missing draft event fails instead of accepting a working REST response', async () => {
  const { startDraftProbe } = await import('./realtime-probe.mjs')
  const draft = '00000000-0000-4000-8000-000000000002'
  let timer = 60
  const c = { leagueId: draft, users: [{ token: 'local' }], onTokenRefresh: () => () => {}, rest: async () => [{ id: draft, pick_timer_seconds: timer }] }
  await assert.rejects(startDraftProbe(c, {}, {
    clientFactory: () => ({ setAuth: async () => {}, subscribe(_topic, _filter, _callback, status, ready) { status('SUBSCRIBED'); ready() }, close: async () => {} }),
    execute: async statement => { timer = Number(/pick_timer_seconds=(\d+)/.exec(statement)[1]) }, pause: async () => {},
  }), /must deliver its row change/)
  assert.equal(timer, 60)
})

test('the draft write waits for the database feed after the channel joins', async () => {
  const { startDraftProbe } = await import('./realtime-probe.mjs')
  const draft = '00000000-0000-4000-8000-000000000003'
  let timer = 90, receive, ready, feedReady = false
  const c = { leagueId: draft, users: [{ token: 'local' }], onTokenRefresh: () => () => {}, rest: async () => [{ id: draft, pick_timer_seconds: timer }] }
  const probe = await startDraftProbe(c, {}, {
    clientFactory: () => ({ setAuth: async () => {}, subscribe(_topic, _filter, callback, status, onReady) {
      receive = callback
      ready = onReady
      status('SUBSCRIBED')
    }, close: async () => {} }),
    execute: async statement => {
      assert.equal(feedReady, true, 'A channel join does not establish the database feed')
      timer = Number(/pick_timer_seconds=(\d+)/.exec(statement)[1])
      receive({ new: { id: draft, pick_timer_seconds: timer } })
    },
    pause: async () => { feedReady = true; ready() },
  })
  assert.equal((await probe.verify()).passed, true)
  await probe.close()
})
