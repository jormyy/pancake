import test from 'node:test'
import assert from 'node:assert/strict'
import { compressionPolicy, officialCompression } from './official-compression.mjs'
import { advanceCron, productionJobs } from './cron.mjs'

const dispatcher = { jobname: 'work-dispatcher', schedule: '* * * * *', command: 'SELECT public.dispatch_work()' }

test('official replay retains the dispatcher without reading retired gate sources', async () => {
  const receipt = {}
  const policy = await officialCompression({}, receipt)
  assert.deepEqual(policy.select(productionJobs), productionJobs)
  assert.equal(receipt.mode, 'work-queue-all-ticks')
  assert.deepEqual(receipt.inspectedSources, [])
  assert.deepEqual(receipt.coalesced, {})
  assert.equal(receipt.queueProofs, 0)
})

test('empty source queues and active workers never suppress a dispatcher tick', async () => {
  const receipt = {}, policy = compressionPolicy(receipt)
  for (const workers of [{ nextAt: null }, { nextAt: 60001 }]) {
    policy.begin()
    await policy.refresh(0, workers)
    assert.deepEqual(policy.select([dispatcher], 60000, workers), [dispatcher])
    assert.deepEqual(policy.select([{ ...dispatcher, command: `${dispatcher.command};SELECT 1` }], 60000, workers), [{ ...dispatcher, command: `${dispatcher.command};SELECT 1` }])
  }
  assert.deepEqual(receipt.coalesced, {})
})

test('dispatcher replay keeps minute ticks and delayed worker wakeups', async () => {
  const moved = [], invoked = [], receipt = {}
  await advanceCron({ from: 0, to: 120000, catalog: [dispatcher], compression: compressionPolicy(receipt), move: async at => moved.push(at), invoke: async command => invoked.push(command), settle: async at => ({ nextAt: at === 60000 ? 80000 : null }) })
  assert.deepEqual(moved, [60000, 80000, 120000, 120000])
  assert.deepEqual(invoked, [dispatcher.command, dispatcher.command])
  assert.deepEqual(receipt.coalesced, {})
})

test('dispatcher replay preserves unknown scheduled jobs alongside the dispatcher', async () => {
  const invoked = []
  const unknown = { jobname: 'unknown', schedule: '* * * * *', command: 'SELECT unknown()' }
  await advanceCron({ from: 0, to: 60000, catalog: [dispatcher, unknown], compression: compressionPolicy({}), move: async () => {}, invoke: async command => invoked.push(command) })
  assert.deepEqual(invoked, [`${dispatcher.command}; ${unknown.command}`])
})

test('forecast expiry and tipoff boundaries retain every production minute', async () => {
  const invoked = [], moved = []
  await advanceCron({ from: 0, to: 180000, catalog: [dispatcher], compression: compressionPolicy({}), move: async at => moved.push(at), invoke: async command => invoked.push(command) })
  assert.deepEqual(invoked, [dispatcher.command, dispatcher.command, dispatcher.command])
  assert.deepEqual(moved, [60000, 120000, 180000, 180000])
})
