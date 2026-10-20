import assert from 'node:assert/strict'
import test from 'node:test'
import { realtimeAuth } from './realtime-probe.mjs'

test('long replay subscriptions receive each refreshed local session token once', async () => {
  const published = []
  const sync = realtimeAuth({ setAuth: async token => { published.push(token) } }, 'first')
  await sync('first')
  await sync('second')
  await sync('second')
  await sync('third')
  assert.deepEqual(published, ['second', 'third'])
})
