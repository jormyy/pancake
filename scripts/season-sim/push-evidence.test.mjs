import assert from 'node:assert/strict'
import test from 'node:test'
import { registerPushOwners } from './push-evidence.mjs'

test('removed Expo signup is skipped and cannot count as device delivery evidence', async () => {
  const calls = []
  const context = { users: [{ id: 'owner', memberId: 'member' }], api: async (...args) => { calls.push(args); throw new Error('Removed Expo signup route') } }
  const result = await registerPushOwners(context, { API_URL: 'http://127.0.0.1:57221' })
  assert.deepEqual(calls, [])
  assert.equal(result.status, 'SKIPPED')
  assert.match(result.reason, /web push/)
  assert.deepEqual(context.pushOwners, [])
})
