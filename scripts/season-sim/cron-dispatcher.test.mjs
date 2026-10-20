import assert from 'node:assert/strict'
import test from 'node:test'
import { canAdvanceWorkers } from './cron-dispatcher.mjs'

test('finished HTTP calls awaiting pg_net collection do not block other sleeping workers', () => {
  const rows = [{ worker_status: 'failed' }, { worker_status: 'running' }, { worker_status: 'running' }]
  const state = { active: 2, sleeping: 2, fetches: 0, nextAt: 376 }
  assert.ok(canAdvanceWorkers(rows, state, 347))
  assert.ok(!canAdvanceWorkers([...rows, { worker_status: 'pending' }], state, 347))
  assert.ok(!canAdvanceWorkers(rows, { ...state, fetches: 1 }, 347))
  assert.ok(!canAdvanceWorkers(rows, { ...state, sleeping: 1 }, 347))
  assert.ok(!canAdvanceWorkers(rows, state, 376))
})
